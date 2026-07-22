'use strict';

const DRIVE_FOLDER_NAME = 'LeetCode-Solutions';
const DRIVE_FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';
const DRIVE_UPLOAD_ENDPOINT = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink';
const DRIVE_FILES_ENDPOINT = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_FOLDER_QUERY_FIELDS = 'files(id,name,mimeType,modifiedTime),nextPageToken';

const tokenCache = {
  accessToken: null
};

// BUG FIX: was never reset on failure, permanently breaking all subsequent calls.
// Now it is cleared whenever the underlying call rejects so the next call retries.
let solutionsFolderIdPromise = null;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'LEETCODE_SAVE_SOLUTION') {
    (async () => {
      try {
        const uploadResult = await saveSolutionToDrive(message.payload);
        sendResponse({
          ok: true,
          fileId: uploadResult.id,
          fileName: uploadResult.name,
          webViewLink: uploadResult.webViewLink || null
        });
      } catch (error) {
        console.error('[Retained] Upload failed:', error);
        sendResponse({
          ok: false,
          error: error?.message || 'Unknown Drive upload failure.'
        });
      }
    })();

    return true;
  }

  if (message?.type === 'LEETCODE_LOOKUP_SAVED_SOLUTION') {
    (async () => {
      try {
        const solution = await lookupSavedSolution(message.payload);
        sendResponse({
          ok: true,
          found: Boolean(solution),
          solution: solution || null
        });
      } catch (error) {
        console.error('[Retained] Saved-solution lookup failed:', error);
        sendResponse({
          ok: false,
          found: false,
          error: error?.message || 'Unknown lookup failure.'
        });
      }
    })();

    return true;
  }

  return false;
});

// BUG FIX: was declared twice — the second declaration caused a SyntaxError that
// crashed the entire service worker, making uploads and lookups silently fail.
function sanitizeFileNamePart(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .trim();
}

function normalizeFileBaseName(value) {
  return sanitizeFileNamePart(value).toLowerCase();
}

function buildFileName(problemTitle, extension) {
  const safeTitle = sanitizeFileNamePart(problemTitle) || 'LeetCode-Solution';
  const safeExtension = String(extension || 'txt').replace(/^\./, '') || 'txt';
  return `${safeTitle}.${safeExtension}`;
}

function getAuthToken(interactive = true) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message || 'Unable to acquire an OAuth token.'));
        return;
      }

      if (!token) {
        reject(new Error('Chrome did not return an OAuth token.'));
        return;
      }

      tokenCache.accessToken = token;
      resolve(token);
    });
  });
}

function removeCachedToken(token) {
  return new Promise((resolve) => {
    if (!token) {
      resolve();
      return;
    }

    chrome.identity.removeCachedAuthToken({ token }, () => resolve());
  });
}

async function fetchWithAuth(url, options = {}, { retryOnAuthError = true, interactive = true } = {}) {
  const token = tokenCache.accessToken || await getAuthToken(interactive);
  const headers = new Headers(options.headers || {});
  headers.set('Authorization', `Bearer ${token}`);

  const response = await fetch(url, {
    ...options,
    headers
  });

  if (response.status === 401 && retryOnAuthError) {
    await removeCachedToken(token);
    tokenCache.accessToken = null;
    return fetchWithAuth(url, options, { retryOnAuthError: false, interactive });
  }

  return response;
}

function getFileBaseName(fileName) {
  const text = String(fileName || '').trim();
  const dotIndex = text.lastIndexOf('.');
  return dotIndex > 0 ? text.slice(0, dotIndex) : text;
}

function getFileExtension(fileName) {
  const text = String(fileName || '').trim();
  const dotIndex = text.lastIndexOf('.');
  return dotIndex > 0 ? text.slice(dotIndex + 1).toLowerCase() : '';
}

function buildProblemCandidates({ problemTitle, problemSlug }) {
  const candidates = new Set();

  if (problemTitle) {
    const titleCandidate = normalizeFileBaseName(problemTitle);
    if (titleCandidate) {
      candidates.add(titleCandidate);
    }
  }

  if (problemSlug) {
    const slugCandidate = normalizeFileBaseName(problemSlug);
    if (slugCandidate) {
      candidates.add(slugCandidate);
    }
  }

  return [...candidates];
}

function parseDriveQueryResponse(responseData) {
  return Array.isArray(responseData?.files) ? responseData.files : [];
}

async function listSolutionFiles(folderId, interactive = false) {
  const files = [];
  let pageToken = '';

  do {
    const query = `'${folderId}' in parents and trashed=false`;
    const url = new URL(DRIVE_FILES_ENDPOINT);
    url.searchParams.set('q', query);
    url.searchParams.set('fields', DRIVE_FOLDER_QUERY_FIELDS);
    url.searchParams.set('pageSize', '1000');
    if (pageToken) {
      url.searchParams.set('pageToken', pageToken);
    }

    const response = await fetchWithAuth(url.toString(), { method: 'GET' }, { interactive });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to list Drive files (${response.status}): ${errorText}`);
    }

    const responseData = await response.json();
    files.push(...parseDriveQueryResponse(responseData));
    pageToken = responseData?.nextPageToken || '';
  } while (pageToken);

  return files;
}


async function trashDriveFile(fileId, interactive = false) {
  const response = await fetchWithAuth(
    `${DRIVE_FILES_ENDPOINT}/${encodeURIComponent(fileId)}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({ trashed: true })
    },
    { interactive }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to trash the existing Drive file (${response.status}): ${errorText}`);
  }

  return response.json();
}

async function findExistingSolutionFiles(folderId, fileName, interactive = false) {
  const files = await listSolutionFiles(folderId, interactive);
  const targetName = normalizeFileBaseName(fileName);

  return files.filter((file) => normalizeFileBaseName(file.name) === targetName);
}

// BUG FIX: cache is now cleared on failure so subsequent calls can retry
// instead of forever returning a rejected promise.
async function getSolutionsFolderId({ interactive = false } = {}) {
  if (!solutionsFolderIdPromise) {
    solutionsFolderIdPromise = getOrCreateSolutionsFolderId(interactive).catch((err) => {
      solutionsFolderIdPromise = null; // allow retry next time
      throw err;
    });
  }

  return solutionsFolderIdPromise;
}

async function getOrCreateSolutionsFolderId(interactive = false) {
  const query = encodeURIComponent(
    `name='${DRIVE_FOLDER_NAME}' and mimeType='${DRIVE_FOLDER_MIME_TYPE}' and trashed=false`
  );

  const listResponse = await fetchWithAuth(
    `${DRIVE_FILES_ENDPOINT}?q=${query}&fields=files(id,name)&pageSize=10`,
    { method: 'GET' },
    { interactive }
  );

  if (!listResponse.ok) {
    throw new Error(`Failed to look up the Drive folder (${listResponse.status}).`);
  }

  const listData = await listResponse.json();
  if (Array.isArray(listData.files) && listData.files.length > 0) {
    return listData.files[0].id;
  }

  const createResponse = await fetchWithAuth(
    DRIVE_FILES_ENDPOINT,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=UTF-8'
      },
      body: JSON.stringify({
        name: DRIVE_FOLDER_NAME,
        mimeType: DRIVE_FOLDER_MIME_TYPE
      })
    },
    { interactive }
  );

  if (!createResponse.ok) {
    const errorText = await createResponse.text();
    throw new Error(`Failed to create the Drive folder (${createResponse.status}): ${errorText}`);
  }

  const createdFolder = await createResponse.json();
  return createdFolder.id;
}

async function fetchDriveFileContent(fileId, interactive = false) {
  const response = await fetchWithAuth(
    `${DRIVE_FILES_ENDPOINT}/${encodeURIComponent(fileId)}?alt=media`,
    { method: 'GET' },
    { interactive }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to download the Drive file (${response.status}): ${errorText}`);
  }

  return response.text();
}

async function lookupSavedSolution(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Missing lookup payload from the content script.');
  }

  const problemTitle = String(payload.problemTitle || '').trim();
  const problemSlug = String(payload.problemSlug || '').trim();
  const preferredExtension = String(payload.preferredExtension || '').replace(/^\./, '').toLowerCase();

  if (!problemTitle && !problemSlug) {
    throw new Error('Could not identify the current LeetCode problem.');
  }

  const folderId = await getSolutionsFolderId({ interactive: false });
  const files = await listSolutionFiles(folderId, false);
  const candidates = buildProblemCandidates({ problemTitle, problemSlug });

  const matchingFiles = files.filter((file) => {
    const baseName = normalizeFileBaseName(getFileBaseName(file.name));
    return candidates.includes(baseName);
  });

  if (!matchingFiles.length) {
    return null;
  }

  const preferredMatch = preferredExtension
    ? matchingFiles.find((file) => getFileExtension(file.name) === preferredExtension)
    : null;

  const bestMatch = preferredMatch || matchingFiles.sort((left, right) => {
    const leftTime = Date.parse(left.modifiedTime || '') || 0;
    const rightTime = Date.parse(right.modifiedTime || '') || 0;
    return rightTime - leftTime;
  })[0];

  const fileContent = await fetchDriveFileContent(bestMatch.id, false);

  return {
    id: bestMatch.id,
    name: bestMatch.name,
    extension: getFileExtension(bestMatch.name),
    content: fileContent
  };
}

function buildMultipartBody(metadata, sourceCode) {
  const boundary = `----leetcode-drive-boundary-${crypto.randomUUID()}`;
  const delimiter = `--${boundary}`;
  const closeDelimiter = `${delimiter}--`;
  const body = [
    delimiter,
    'Content-Type: application/json; charset=UTF-8',
    '',
    JSON.stringify(metadata),
    delimiter,
    'Content-Type: text/plain; charset=UTF-8',
    '',
    sourceCode,
    closeDelimiter,
    ''
  ].join('\r\n');

  return {
    body,
    contentType: `multipart/related; boundary=${boundary}`
  };
}

async function uploadSolutionFile({ problemTitle, extension, code, language, problemPath }) {
  const folderId = await getSolutionsFolderId({ interactive: true });
  const fileName = buildFileName(problemTitle, extension);

  // Only trash a previous file if BOTH the name and extension match exactly —
  // e.g. saving a new .py solution won't touch an existing .cpp one for the same problem.
  const existingFiles = await findExistingSolutionFiles(folderId, fileName, true);
  for (const existingFile of existingFiles) {
    try {
      await trashDriveFile(existingFile.id, true);
    } catch (error) {
      console.warn('[Retained] Could not trash previous solution file:', existingFile.name, error);
    }
  }

  const metadata = {
    name: fileName,
    parents: [folderId],
    mimeType: 'text/plain',
    description: `LeetCode problem: ${problemTitle}${language ? ` | Language: ${language}` : ''}${problemPath ? ` | Path: ${problemPath}` : ''}`
  };

  const multipart = buildMultipartBody(metadata, code);

  const uploadResponse = await fetchWithAuth(
    DRIVE_UPLOAD_ENDPOINT,
    {
      method: 'POST',
      headers: { 'Content-Type': multipart.contentType },
      body: multipart.body
    }
  );

  if (!uploadResponse.ok) {
    const errorText = await uploadResponse.text();
    throw new Error(`Drive upload failed (${uploadResponse.status}): ${errorText}`);
  }

  return uploadResponse.json();
}

async function saveSolutionToDrive(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Missing payload from the content script.');
  }

  const problemTitle = String(payload.problemTitle || '').trim();
  const code = String(payload.code || '');
  const extension = String(payload.extension || 'txt').replace(/^\./, '') || 'txt';

  if (!problemTitle) {
    throw new Error('The problem title could not be determined.');
  }

  if (!code.trim()) {
    throw new Error('The editor code was empty.');
  }

  return uploadSolutionFile({
    problemTitle,
    extension,
    code,
    language: String(payload.language || '').trim(),
    problemPath: String(payload.problemPath || '').trim()
  });
}

console.info('[Retained] Background service worker initialized.');
