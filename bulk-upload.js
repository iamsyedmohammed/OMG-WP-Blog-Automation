import axios from 'axios';
import csv from 'csv-parser';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import mime from 'mime-types';
import dotenv from 'dotenv';
import readline from 'readline';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
dotenv.config();

/**
 * Parse and get client configuration
 * CTS-only mode: uses single-client configuration (WP_SITE, WP_USER, WP_APP_PASSWORD)
 */
function getClientConfig(clientId = null) {
  // CTS-only: Always use single-client configuration
  return {
    wp_site: process.env.WP_SITE?.replace(/\/$/, '') || '',
    wp_user: process.env.WP_USER || '',
    wp_app_password: process.env.WP_APP_PASSWORD || '',
    default_status: process.env.DEFAULT_STATUS || 'draft',
    request_delay_ms: parseInt(process.env.REQUEST_DELAY_MS || '300', 10),
    name: 'OMG Nafisas',
  };
}

/**
 * Get all available clients
 * CTS-only mode: returns empty array (no client selection needed)
 */
export function getAvailableClients() {
  return [];
}

// Get default client config
const defaultConfig = getClientConfig();
const WP_SITE = defaultConfig.wp_site;
const WP_USER = defaultConfig.wp_user;
const WP_APP_PASSWORD = defaultConfig.wp_app_password;
const CSV_PATH = process.env.CSV_PATH || 'posts.csv';
const DEFAULT_STATUS = defaultConfig.default_status;
const REQUEST_DELAY_MS = defaultConfig.request_delay_ms;

// Validate required config
if (!WP_SITE || !WP_USER || !WP_APP_PASSWORD) {
  console.error('❌ Missing required environment variables: WP_SITE, WP_USER, WP_APP_PASSWORD (or CLIENTS_CONFIG)');
  process.exit(1);
}

/**
 * Create axios instance with auth for a specific client
 */
function createApiInstance(clientConfig) {
  const auth = Buffer.from(`${clientConfig.wp_user}:${clientConfig.wp_app_password}`).toString('base64');
  return axios.create({
    baseURL: `${clientConfig.wp_site}/wp-json/wp/v2`,
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/json',
    },
    timeout: 30000,
  });
}

// Default API instance (for backward compatibility)
const auth = Buffer.from(`${WP_USER}:${WP_APP_PASSWORD}`).toString('base64');
const api = axios.create({
  baseURL: `${WP_SITE}/wp-json/wp/v2`,
  headers: {
    'Authorization': `Basic ${auth}`,
    'Content-Type': 'application/json',
  },
  timeout: 30000,
});

// Logging
let logResults = [];
let startTime = Date.now();

const logFile = path.join(__dirname, 'upload_debug.log');
const originalLog = console.log;
const originalError = console.error;

console.log = function (...args) {
  const message = args.map(arg => String(arg)).join(' ');
  fs.appendFileSync(logFile, message + '\n');
  originalLog.apply(console, args);
};

console.error = function (...args) {
  const message = args.map(arg => String(arg)).join(' ');
  fs.appendFileSync(logFile, 'ERROR: ' + message + '\n');
  originalError.apply(console, args);
};

/**
 * Sleep for specified milliseconds
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Prompt user for CSV file path
 */
function promptForCsvPath(defaultPath) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    const promptText = defaultPath
      ? `\n📁 Enter CSV file path [${defaultPath}]: `
      : '\n📁 Enter CSV file path: ';

    rl.question(promptText, (answer) => {
      rl.close();
      const userInput = answer.trim();
      // If user pressed Enter, use the suggested default; otherwise use their input
      resolve(userInput || defaultPath || 'posts.csv');
    });
  });
}

/**
 * Load and parse CSV file
 */
async function loadCsv(filePath) {
  return new Promise((resolve, reject) => {
    const results = [];
    // Support both absolute and relative paths
    const fullPath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(__dirname, filePath);

    if (!fs.existsSync(fullPath)) {
      reject(new Error(`CSV file not found: ${fullPath}`));
      return;
    }

    fs.createReadStream(fullPath)
      .pipe(csv())
      .on('data', (data) => results.push(data))
      .on('end', () => resolve(results))
      .on('error', (error) => reject(error));
  });
}

/**
 * Check WordPress REST API connectivity
 */
async function checkConnectivity() {
  return checkConnectivityWithApi(api, WP_SITE);
}

/**
 * Check WordPress REST API connectivity with specific API instance
 */
async function checkConnectivityWithApi(apiInstance, siteUrl) {
  try {
    console.log('🔍 Checking WordPress REST API connectivity...');
    const response = await apiInstance.get('/posts', { params: { per_page: 1 } });
    console.log('✅ WordPress REST API is accessible\n');
    return true;
  } catch (error) {
    if (error.response?.status === 401) {
      console.error('❌ Authentication failed. Check WP_USER and WP_APP_PASSWORD.');
    } else if (error.response?.status === 403) {
      console.error('❌ REST API is blocked. Enable it in WordPress settings.');
    } else if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
      console.error(`❌ Cannot reach ${siteUrl}. Check WP_SITE URL.`);
    } else {
      console.error(`❌ Connectivity check failed: ${error.message}`);
    }
    return false;
  }
}

/**
 * Get or create a taxonomy term (category or tag)
 */
async function getOrCreateTerm(name, taxonomy = 'categories', apiInstance = api, clientConfig = null) {
  if (!name || !name.trim()) return null;

  const trimmedName = name.trim();
  const currentApi = apiInstance || api;
  const config = clientConfig || defaultConfig;

  try {
    // Search for existing term
    const searchResponse = await currentApi.get(`/${taxonomy}`, {
      params: { search: trimmedName, per_page: 100 },
    });

    const existing = searchResponse.data.find(
      term => term.name.toLowerCase() === trimmedName.toLowerCase()
    );

    if (existing) {
      return existing.id;
    }

    // Create new term
    await sleep(config.request_delay_ms);
    const createResponse = await currentApi.post(`/${taxonomy}`, {
      name: trimmedName,
    });

    return createResponse.data.id;
  } catch (error) {
    console.error(`⚠️  Failed to get/create ${taxonomy} "${trimmedName}": ${error.message}`);
    return null;
  }
}

/**
 * Resolve multiple terms from comma-separated string
 */
async function resolveTerms(termString, taxonomy, apiInstance = api, clientConfig = null) {
  if (!termString || !termString.trim()) return [];

  const names = termString.split(',').map(n => n.trim()).filter(Boolean);
  const termIds = [];
  const currentApi = apiInstance || api;
  const config = clientConfig || defaultConfig;

  for (const name of names) {
    const id = await getOrCreateTerm(name, taxonomy, currentApi, config);
    if (id) {
      termIds.push(id);
    }
    await sleep(config.request_delay_ms);
  }

  return termIds;
}

/**
 * Download image from URL
 */
async function downloadImageFromUrl(imageUrl) {
  try {
    const response = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      timeout: 30000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      }
    });

    const contentType = response.headers['content-type'];

    // Check for HTML content (indicates error/login page)
    if (contentType && contentType.includes('text/html')) {
      console.warn(`⚠️  Downloaded content is HTML, not an image. This usually means the Google Drive link is private.`);
      console.warn(`   URL: ${imageUrl}`);
      console.warn(`   Action: Please change permissions to "Anyone with the link" on Google Drive.`);
      return null;
    }

    let fileName = 'image.jpg';
    const contentDisposition = response.headers['content-disposition'];

    // Try to get filename from Content-Disposition
    if (contentDisposition) {
      const filenameMatch = contentDisposition.match(/filename="?([^"]+)"?/);
      if (filenameMatch && filenameMatch[1]) {
        fileName = filenameMatch[1];
      }
    } else {
      // Fallback to URL path
      const urlPath = new URL(imageUrl).pathname;
      fileName = path.basename(urlPath) || 'image';
    }

    // Ensure filename has correct extension based on Content-Type
    const extFromMime = mime.extension(contentType);
    if (extFromMime) {
      const currentExt = path.extname(fileName).replace('.', '');
      if (currentExt !== extFromMime) {
        // If no extension or wrong extension, append the correct one
        if (!currentExt || currentExt === 'uc') { // 'uc' is common for GDrive export links
          fileName = `${fileName}.${extFromMime}`;
        } else {
          // Replace extension
          fileName = fileName.replace(new RegExp(`\\.${currentExt}$`), `.${extFromMime}`);
        }
      }
    }

    return {
      buffer: Buffer.from(response.data),
      mimeType: contentType || mime.lookup(imageUrl) || 'image/jpeg',
      fileName: fileName,
    };
  } catch (error) {
    console.error(`⚠️  Failed to download image from URL "${imageUrl}": ${error.message}`);
    return null;
  }
}

/**
 * Convert Google Drive URL to direct download URL
 */
function convertGoogleDriveUrl(url) {
  if (!url) return url;

  // Check if it's a Google Drive URL
  if (url.includes('drive.google.com')) {
    // Try to extract the ID
    // Matches /file/d/ID/view or /open?id=ID
    const idMatch = url.match(/\/d\/([a-zA-Z0-9_-]+)/) || url.match(/id=([a-zA-Z0-9_-]+)/);

    if (idMatch && idMatch[1]) {
      const fileId = idMatch[1];
      console.log(`   🔄 Converting Google Drive URL to direct link (ID: ${fileId})`);
      return `https://drive.google.com/uc?export=download&id=${fileId}`;
    }
  }

  return url;
}

/**
 * Upload featured image to WordPress media library (from local file or URL)
 */
async function uploadMedia(filePathOrUrl, apiInstance = api) {
  const currentApi = apiInstance || api;
  if (!filePathOrUrl || !filePathOrUrl.trim()) return null;

  let fileBuffer, fileName, mimeType;
  let processedUrl = filePathOrUrl.trim();

  // Check if it's a URL (starts with http:// or https://)
  if (processedUrl.startsWith('http://') || processedUrl.startsWith('https://')) {
    // Handle Google Drive URLs
    processedUrl = convertGoogleDriveUrl(processedUrl);

    // Download from URL
    const downloaded = await downloadImageFromUrl(processedUrl);
    if (!downloaded) return null;

    fileBuffer = downloaded.buffer;
    fileName = downloaded.fileName;
    mimeType = downloaded.mimeType;
  } else {
    // Local file path
    const fullPath = path.resolve(__dirname, processedUrl);

    if (!fs.existsSync(fullPath)) {
      console.error(`⚠️  Image file not found: ${fullPath}`);
      return null;
    }

    fileBuffer = fs.readFileSync(fullPath);
    fileName = path.basename(fullPath);
    mimeType = mime.lookup(fullPath) || 'application/octet-stream';
  }

  try {
    const config = defaultConfig;
    await sleep(config.request_delay_ms);

    const response = await currentApi.post('/media', fileBuffer, {
      headers: {
        'Content-Type': mimeType,
        'Content-Disposition': `attachment; filename="${fileName}"`,
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });

    return response.data.id;
  } catch (error) {
    console.error(`⚠️  Failed to upload media "${filePathOrUrl}": ${error.message}`);
    if (error.response?.data) {
      console.error(`   Error details: ${JSON.stringify(error.response.data)}`);
    }
    return null;
  }
}

/**
 * Find existing post by slug
 */
async function findPostBySlug(slug, apiInstance = api) {
  if (!slug || !slug.trim()) return null;

  const currentApi = apiInstance || api;

  try {
    const response = await currentApi.get('/posts', {
      params: { slug: slug.trim(), per_page: 1 },
    });

    if (response.data && response.data.length > 0) {
      return response.data[0].id;
    }

    return null;
  } catch (error) {
    console.error(`⚠️  Failed to search for post by slug "${slug}": ${error.message}`);
    return null;
  }
}

/**
 * Find existing post by title
 */
async function findPostByTitle(title, apiInstance = api) {
  const currentApi = apiInstance || api;
  if (!title || !title.trim()) return null;

  try {
    // Normalize title for comparison (remove HTML entities, trim, lowercase)
    const normalizeTitle = (str) => {
      if (!str) return '';
      // Remove HTML entities and tags, then normalize
      // Handle common HTML entities first, then remove any remaining
      return str
        .replace(/<[^>]*>/g, '') // Remove HTML tags
        .replace(/&nbsp;/g, ' ') // Replace &nbsp; with space
        .replace(/&amp;/g, '&') // Replace &amp; with &
        .replace(/&quot;/g, '"') // Replace &quot; with "
        .replace(/&#8217;/g, "'") // Replace &#8217; (right single quotation) with '
        .replace(/&#8216;/g, "'") // Replace &#8216; (left single quotation) with '
        .replace(/&#39;/g, "'") // Replace &#39; with '
        .replace(/&#038;/g, '&') // Replace &#038; with &
        .replace(/&[^;]+;/g, '') // Remove any other HTML entities
        .replace(/\s+/g, ' ') // Normalize whitespace
        .toLowerCase()
        .trim();
    };

    const normalizedSearchTitle = normalizeTitle(title);
    console.log(`🔍 Searching for duplicate. Normalized title: "${normalizedSearchTitle}"`);

    // Paginate through ALL posts (including drafts) to check for duplicates
    // WordPress search API might not return drafts, so we check all posts directly
    let page = 1;
    const perPage = 100;
    let hasMore = true;
    let totalChecked = 0;

    while (hasMore) {
      const response = await currentApi.get('/posts', {
        params: {
          per_page: perPage,
          page: page,
          status: 'any', // Include all statuses: publish, draft, private, pending, future
          orderby: 'date',
          order: 'desc'
        },
      });

      if (!response.data || response.data.length === 0) {
        hasMore = false;
        break;
      }

      totalChecked += response.data.length;
      console.log(`🔍 Checking page ${page}, ${response.data.length} posts (total checked: ${totalChecked})`);

      // Check each post in this page
      for (const post of response.data) {
        // Try multiple ways to get the title
        const postTitleRaw = post.title?.rendered || post.title?.raw || post.title || '';
        const postTitleNormalized = normalizeTitle(postTitleRaw);

        // Debug: log posts that might match (to reduce noise but still catch issues)
        const isMatch = postTitleNormalized === normalizedSearchTitle;
        const mightMatch = postTitleNormalized.includes('weekend brunch') ||
          postTitleNormalized.includes('nafisa') ||
          postTitleRaw.toLowerCase().includes('weekend brunch');

        if (isMatch || mightMatch) {
          console.log(`  📝 Post ID ${post.id} (${post.status}): "${postTitleRaw}"`);
          console.log(`     Normalized: "${postTitleNormalized}"`);
          console.log(`     Search for: "${normalizedSearchTitle}"`);
          console.log(`     Match: ${isMatch ? '✅ YES - DUPLICATE FOUND!' : '❌ NO'}`);
        }

        if (isMatch) {
          console.log(`✅ FOUND DUPLICATE! Post ID ${post.id} (status: ${post.status}) has matching title: "${postTitleRaw}"`);
          return post.id;
        }
      }

      // If we got fewer posts than requested, we've reached the end
      if (response.data.length < perPage) {
        hasMore = false;
      } else {
        page++;
        // Limit to first 10 pages (1000 posts) to avoid infinite loops
        if (page > 10) {
          console.log(`⚠️  Reached 1000 post limit. Stopping search.`);
          hasMore = false;
        }
      }
    }

    console.log(`✅ No duplicate found after checking ${totalChecked} posts`);
    return null;
  } catch (error) {
    console.error(`⚠️  Failed to search for post by title "${title}": ${error.message}`);
    // Don't throw - return null so we can continue processing other posts
    return null;
  }
}

/**
 * Create or update a post
 */
async function createOrUpdatePost(row, rowNumber, progressCallback = null, apiInstance = api, clientConfig = null) {
  // Use provided API instance or default
  const currentApi = apiInstance || api;
  const config = clientConfig || defaultConfig;
  const result = {
    rowNumber,
    title: row.title || 'Untitled',
    action: null,
    postId: null,
    status: null,
    error: null,
  };

  try {
    // Validate required fields
    if (!row.title || !row.title.trim()) {
      throw new Error('Missing required field: title');
    }
    if (!row.content || !row.content.trim()) {
      throw new Error('Missing required field: content');
    }

    // Prepare post data
    const postData = {
      title: row.title.trim(),
      content: row.content.trim(),
      status: row.status?.trim() || config.default_status,
    };

    // Add optional fields
    if (row.slug?.trim()) {
      postData.slug = row.slug.trim();
    }
    if (row.excerpt?.trim()) {
      postData.excerpt = row.excerpt.trim();
    }

    // Handle ACF JSON
    if (row.acf_json?.trim()) {
      try {
        const acfData = JSON.parse(row.acf_json);
        postData.acf = acfData;
      } catch (parseError) {
        console.error(`⚠️  Invalid ACF JSON in row ${rowNumber}: ${parseError.message}`);
      }
    }

    // Resolve categories
    if (row.categories?.trim()) {
      const categoryIds = await resolveTerms(row.categories, 'categories', currentApi, config);
      if (categoryIds.length > 0) {
        postData.categories = categoryIds;
      }
    }

    // Resolve tags
    if (row.tags?.trim()) {
      const tagIds = await resolveTerms(row.tags, 'tags', currentApi, config);
      if (tagIds.length > 0) {
        postData.tags = tagIds;
      }
    }

    // Upload featured image if provided (supports both local path and URL)
    const imagePath = row.featured_image_path?.trim() || row.featured_image_url?.trim();
    if (imagePath) {
      const mediaId = await uploadMedia(imagePath, currentApi);
      if (mediaId) {
        postData.featured_media = mediaId;
      }
    }

    // Handle Meta Title, Description, and Focus Keyword
    const metaTitle = row.meta_title?.trim();
    const metaDesc = row.meta_description?.trim();
    const focusKw = row.focus_keyword?.trim();

    if (metaTitle || metaDesc || focusKw) {
      // When using register_rest_field (via our helper plugin), these must be top-level fields

      if (metaTitle) {
        // Generic
        postData.meta_title = metaTitle;
        // Yoast SEO
        postData._yoast_wpseo_title = metaTitle;
        // Rank Math
        postData.rank_math_title = metaTitle;
      }

      if (metaDesc) {
        // Generic
        postData.meta_description = metaDesc;
        // Yoast SEO
        postData._yoast_wpseo_metadesc = metaDesc;
        // Rank Math
        postData.rank_math_description = metaDesc;
      }

      if (focusKw) {
        // Yoast SEO
        postData._yoast_wpseo_focuskw = focusKw;
        // Rank Math
        postData.rank_math_focus_keyword = focusKw;
      }
    }

    // Check for existing post by title first (prevent duplicates)
    // This check happens BEFORE creating the post to prevent duplicate creation
    console.log(`[${rowNumber}] 🔍 Checking for duplicate post with title: "${postData.title}"`);
    const existingPostByTitle = await findPostByTitle(postData.title, currentApi);
    if (existingPostByTitle) {
      const errorMsg = `Post with title "${postData.title}" already exists (ID: ${existingPostByTitle}). Duplicate posts are not allowed.`;
      console.error(`[${rowNumber}] ⚠️  DUPLICATE DETECTED: ${errorMsg}`);
      throw new Error(errorMsg);
    }
    console.log(`[${rowNumber}] ✅ No duplicate found for title: "${postData.title}"`);

    // Check for existing post by slug (idempotency)
    let existingPostId = null;
    if (postData.slug) {
      existingPostId = await findPostBySlug(postData.slug, currentApi);
    }

    // Create or update
    await sleep(config.request_delay_ms);

    if (existingPostId) {
      // Update existing post
      const updateResponse = await currentApi.post(`/posts/${existingPostId}`, postData);
      result.action = 'updated';
      result.postId = updateResponse.data.id;
      result.status = updateResponse.data.status;
      const message = `[${rowNumber}] ✅ updated post ${result.postId}: ${result.title}`;
      console.log(message);
      if (progressCallback) progressCallback({ type: 'success', message, rowNumber, postId: result.postId, title: result.title });
    } else {
      // Create new post
      const createResponse = await currentApi.post('/posts', postData);
      result.action = 'created';
      result.postId = createResponse.data.id;
      result.status = createResponse.data.status;
      const message = `[${rowNumber}] ✅ created post ${result.postId}: ${result.title}`;
      console.log(message);
      if (progressCallback) progressCallback({ type: 'success', message, rowNumber, postId: result.postId, title: result.title });
    }
  } catch (error) {
    result.error = error.message;
    if (error.response?.data) {
      result.error = `${error.message}: ${JSON.stringify(error.response.data)}`;
    }
    const errorMessage = `[${rowNumber}] ❌ failed: ${result.title} - ${result.error}`;
    console.error(errorMessage);
    if (progressCallback) progressCallback({ type: 'error', message: errorMessage, rowNumber, title: result.title, error: result.error });
  }

  return result;
}

/**
 * Main execution
 */
async function main() {
  console.log('🚀 WordPress Bulk Uploader\n');
  console.log(`Site: ${WP_SITE}`);
  console.log(`Default Status: ${DEFAULT_STATUS}`);
  console.log(`Request Delay: ${REQUEST_DELAY_MS}ms`);

  // Get CSV path: command-line argument > interactive prompt (with env as suggestion) > default
  let csvPath;

  // If command-line argument provided, use it directly (skip prompt)
  if (process.argv[2]) {
    csvPath = process.argv[2];
    console.log(`\nCSV: ${csvPath} (from command-line argument)`);
  } else {
    // Always prompt for file path, showing env variable as suggestion if it exists
    const suggestedPath = process.env.CSV_PATH || 'posts.csv';
    csvPath = await promptForCsvPath(suggestedPath);
    console.log(`\nCSV: ${csvPath}`);
  }

  // Check connectivity
  const isConnected = await checkConnectivity();
  if (!isConnected) {
    process.exit(1);
  }

  // Load CSV
  console.log(`📖 Loading CSV: ${csvPath}...`);
  let rows;
  try {
    rows = await loadCsv(csvPath);
    console.log(`✅ Loaded ${rows.length} row(s)\n`);
  } catch (error) {
    console.error(`❌ Failed to load CSV: ${error.message}`);
    console.error(`\n💡 Tips:`);
    console.error(`   - Use absolute path: C:\\Users\\YourName\\Documents\\file.csv`);
    console.error(`   - Use relative path: posts.csv (from script directory)`);
    console.error(`   - Or pass as argument: npm run upload "C:\\path\\to\\file.csv"`);
    process.exit(1);
  }

  if (rows.length === 0) {
    console.log('⚠️  CSV file is empty');
    process.exit(0);
  }

  // Process each row
  console.log('📤 Starting upload process...\n');
  for (let i = 0; i < rows.length; i++) {
    const result = await createOrUpdatePost(rows[i], i + 1, null, api, defaultConfig);
    logResults.push(result);
  }

  // Write log file
  // Use /tmp on Vercel (serverless), or __dirname for local development
  const isVercel = process.env.VERCEL || process.env.VERCEL_ENV;
  const logPath = isVercel
    ? path.join('/tmp', 'import_log.json')
    : path.resolve(__dirname, 'import_log.json');
  fs.writeFileSync(logPath, JSON.stringify(logResults, null, 2));
  console.log(`\n📝 Log written to: ${logPath}`);

  // Summary
  const endTime = Date.now();
  const duration = ((endTime - startTime) / 1000).toFixed(2);
  const successCount = logResults.filter(r => !r.error).length;
  const failedCount = logResults.filter(r => r.error).length;

  console.log('\n' + '='.repeat(50));
  console.log('📊 Summary');
  console.log('='.repeat(50));
  console.log(`✅ Success: ${successCount}`);
  console.log(`❌ Failed: ${failedCount}`);
  console.log(`⏱️  Total Time: ${duration}s`);
  console.log('='.repeat(50) + '\n');

  process.exit(failedCount > 0 ? 1 : 0);
}

/**
 * Process CSV file (exported for use by web server)
 */
export async function processCsvFile(csvPath, progressCallback = null, clientId = null) {
  // Reset logging for new run
  logResults = [];
  startTime = Date.now();

  // Get client configuration
  const clientConfig = getClientConfig(clientId);
  const clientApi = createApiInstance(clientConfig);

  // Override the global api instance for this run
  const originalApi = api;
  Object.setPrototypeOf(clientApi, api);

  // Check connectivity
  if (progressCallback) progressCallback({ type: 'info', message: `🔍 Checking WordPress REST API connectivity for ${clientConfig.name}...` });
  const isConnected = await checkConnectivityWithApi(clientApi, clientConfig.wp_site);
  if (!isConnected) {
    throw new Error(`WordPress REST API is not accessible for ${clientConfig.name}. Check your configuration.`);
  }
  if (progressCallback) progressCallback({ type: 'info', message: `✅ WordPress REST API is accessible for ${clientConfig.name}` });

  // Load CSV
  if (progressCallback) progressCallback({ type: 'info', message: '📖 Loading CSV file...' });
  let rows;
  try {
    rows = await loadCsv(csvPath);
  } catch (error) {
    throw new Error(`Failed to load CSV: ${error.message}`);
  }

  if (rows.length === 0) {
    throw new Error('CSV file is empty');
  }
  if (progressCallback) progressCallback({ type: 'info', message: `✅ Loaded ${rows.length} row(s)` });
  if (progressCallback) progressCallback({ type: 'info', message: '📤 Starting upload process...' });

  // Process each row with client-specific config
  for (let i = 0; i < rows.length; i++) {
    const result = await createOrUpdatePost(rows[i], i + 1, progressCallback, clientApi, clientConfig);
    logResults.push(result);
  }

  // Write log file
  // Use /tmp on Vercel (serverless), or __dirname for local development
  const isVercel = process.env.VERCEL || process.env.VERCEL_ENV;
  const logPath = isVercel
    ? path.join('/tmp', 'import_log.json')
    : path.resolve(__dirname, 'import_log.json');

  try {
    fs.writeFileSync(logPath, JSON.stringify(logResults, null, 2));
  } catch (error) {
    // If writing fails (e.g., on Vercel), log to console instead
    console.warn('⚠️  Could not write log file:', error.message);
    console.log('📝 Log data:', JSON.stringify(logResults, null, 2));
  }

  // Summary
  const endTime = Date.now();
  const duration = ((endTime - startTime) / 1000).toFixed(2);
  const successCount = logResults.filter(r => !r.error).length;
  const failedCount = logResults.filter(r => r.error).length;

  return {
    total: rows.length,
    success: successCount,
    failed: failedCount,
    duration: parseFloat(duration),
    results: logResults,
    logPath: logPath
  };
}

// Run CLI version if called directly
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.includes('bulk-upload.js')) {
  main().catch(error => {
    console.error('❌ Fatal error:', error.message);
    process.exit(1);
  });
}

