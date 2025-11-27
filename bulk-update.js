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
 * Supports both single-client (WP_SITE, WP_USER, WP_APP_PASSWORD) 
 * and multi-client (CLIENTS_CONFIG) modes
 */
function getClientConfig(clientId = null) {
  // Check for multi-client configuration
  if (process.env.CLIENTS_CONFIG) {
    try {
      const clientsConfig = JSON.parse(process.env.CLIENTS_CONFIG);
      
      // If clientId provided, return that specific client
      if (clientId && clientsConfig[clientId]) {
        const client = clientsConfig[clientId];
        return {
          wp_site: client.wp_site?.replace(/\/$/, '') || '',
          wp_user: client.wp_user || '',
          wp_app_password: client.wp_app_password || '',
          default_status: client.default_status || 'draft',
          request_delay_ms: parseInt(client.request_delay_ms || '300', 10),
          name: client.name || clientId,
        };
      }
      
      // If no clientId, return first client or null
      const firstClientId = Object.keys(clientsConfig)[0];
      if (firstClientId) {
        const client = clientsConfig[firstClientId];
        return {
          wp_site: client.wp_site?.replace(/\/$/, '') || '',
          wp_user: client.wp_user || '',
          wp_app_password: client.wp_app_password || '',
          default_status: client.default_status || 'draft',
          request_delay_ms: parseInt(client.request_delay_ms || '300', 10),
          name: client.name || firstClientId,
        };
      }
    } catch (error) {
      console.error('⚠️  Failed to parse CLIENTS_CONFIG:', error.message);
    }
  }
  
  // Fall back to single-client configuration
  return {
    wp_site: process.env.WP_SITE?.replace(/\/$/, '') || '',
    wp_user: process.env.WP_USER || '',
    wp_app_password: process.env.WP_APP_PASSWORD || '',
    default_status: process.env.DEFAULT_STATUS || 'draft',
    request_delay_ms: parseInt(process.env.REQUEST_DELAY_MS || '300', 10),
    name: 'WordPress Site',
  };
}

/**
 * Get all available clients
 */
export function getAvailableClients() {
  if (process.env.CLIENTS_CONFIG) {
    try {
      const clientsConfig = JSON.parse(process.env.CLIENTS_CONFIG);
      return Object.entries(clientsConfig).map(([id, config]) => ({
        id,
        name: config.name || id,
        wp_site: config.wp_site,
      }));
    } catch (error) {
      console.error('⚠️  Failed to parse CLIENTS_CONFIG:', error.message);
    }
  }
  return [];
}

// Get default client config
const defaultConfig = getClientConfig();
const WP_SITE = defaultConfig.wp_site;
const WP_USER = defaultConfig.wp_user;
const WP_APP_PASSWORD = defaultConfig.wp_app_password;
const CSV_PATH = process.env.CSV_PATH || 'posts.csv';
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
    const searchResponse = await currentApi.get(`/${taxonomy}`, {
      params: { search: trimmedName, per_page: 100 },
    });

    const existing = searchResponse.data.find(
      term => term.name.toLowerCase() === trimmedName.toLowerCase()
    );

    if (existing) {
      return existing.id;
    }

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
    });
    
    return {
      buffer: Buffer.from(response.data),
      mimeType: response.headers['content-type'] || mime.lookup(imageUrl) || 'image/jpeg',
      fileName: path.basename(new URL(imageUrl).pathname) || 'image.jpg',
    };
  } catch (error) {
    console.error(`⚠️  Failed to download image from URL "${imageUrl}": ${error.message}`);
    return null;
  }
}

/**
 * Upload featured image to WordPress media library
 */
async function uploadMedia(filePathOrUrl, apiInstance = api, clientConfig = null) {
  const currentApi = apiInstance || api;
  const config = clientConfig || defaultConfig;
  if (!filePathOrUrl || !filePathOrUrl.trim()) return null;

  let fileBuffer, fileName, mimeType;

  if (filePathOrUrl.trim().startsWith('http://') || filePathOrUrl.trim().startsWith('https://')) {
    const downloaded = await downloadImageFromUrl(filePathOrUrl.trim());
    if (!downloaded) return null;
    
    fileBuffer = downloaded.buffer;
    fileName = downloaded.fileName;
    mimeType = downloaded.mimeType;
  } else {
    const fullPath = path.resolve(__dirname, filePathOrUrl);
    
    if (!fs.existsSync(fullPath)) {
      console.error(`⚠️  Image file not found: ${fullPath}`);
      return null;
    }

    fileBuffer = fs.readFileSync(fullPath);
    fileName = path.basename(fullPath);
    mimeType = mime.lookup(fullPath) || 'application/octet-stream';
  }

  try {
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
 * Find post by ID
 */
async function findPostById(postId, apiInstance = api) {
  if (!postId) return null;

  const currentApi = apiInstance || api;

  try {
    const response = await currentApi.get(`/posts/${postId}`);
    return response.data.id;
  } catch (error) {
    if (error.response?.status === 404) {
      return null;
    }
    console.error(`⚠️  Failed to find post by ID "${postId}": ${error.message}`);
    return null;
  }
}

/**
 * Find post by slug
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
 * Find post by title
 */
async function findPostByTitle(title, apiInstance = api) {
  const currentApi = apiInstance || api;
  if (!title || !title.trim()) return null;

  try {
    const normalizeTitle = (str) => {
      if (!str) return '';
      return str
        .replace(/<[^>]*>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#8217;/g, "'")
        .replace(/&#8216;/g, "'")
        .replace(/&#39;/g, "'")
        .replace(/&#038;/g, '&')
        .replace(/&[^;]+;/g, '')
        .replace(/\s+/g, ' ')
        .toLowerCase()
        .trim();
    };

    const normalizedSearchTitle = normalizeTitle(title);
    
    let page = 1;
    const perPage = 100;
    let hasMore = true;

    while (hasMore) {
      const response = await currentApi.get('/posts', {
        params: { 
          per_page: perPage,
          page: page,
          status: 'any',
          orderby: 'date',
          order: 'desc'
        },
      });

      if (!response.data || response.data.length === 0) {
        hasMore = false;
        break;
      }

      for (const post of response.data) {
        const postTitleRaw = post.title?.rendered || post.title?.raw || post.title || '';
        const postTitleNormalized = normalizeTitle(postTitleRaw);
        
        if (postTitleNormalized === normalizedSearchTitle) {
          return post.id;
        }
      }

      if (response.data.length < perPage) {
        hasMore = false;
      } else {
        page++;
        if (page > 10) {
          console.log(`⚠️  Reached 1000 post limit. Stopping search.`);
          hasMore = false;
        }
      }
    }

    return null;
  } catch (error) {
    console.error(`⚠️  Failed to search for post by title "${title}": ${error.message}`);
    return null;
  }
}

/**
 * Update an existing post
 */
async function updatePost(row, rowNumber, progressCallback = null, apiInstance = api, clientConfig = null) {
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
    // Find the post to update - priority: post_id > slug > title
    let postId = null;

    if (row.post_id?.trim()) {
      postId = await findPostById(row.post_id.trim(), currentApi);
      if (!postId) {
        throw new Error(`Post with ID "${row.post_id}" not found`);
      }
    } else if (row.slug?.trim()) {
      postId = await findPostBySlug(row.slug.trim(), currentApi);
      if (!postId) {
        throw new Error(`Post with slug "${row.slug}" not found`);
      }
    } else if (row.title?.trim()) {
      postId = await findPostByTitle(row.title.trim(), currentApi);
      if (!postId) {
        throw new Error(`Post with title "${row.title}" not found`);
      }
    } else {
      throw new Error('Missing identifier: must provide post_id, slug, or title');
    }

    result.postId = postId;

    // Get existing post to preserve fields not being updated
    const existingPostResponse = await currentApi.get(`/posts/${postId}`);
    const existingPost = existingPostResponse.data;

    // Prepare update data - only include fields that are provided
    const updateData = {};

    // Update title if provided
    if (row.title?.trim()) {
      updateData.title = row.title.trim();
    }

    // Update content if provided
    if (row.content?.trim()) {
      updateData.content = row.content.trim();
    }

    // Update status if provided
    if (row.status?.trim()) {
      updateData.status = row.status.trim();
    }

    // Update slug if provided
    if (row.slug?.trim()) {
      updateData.slug = row.slug.trim();
    }

    // Update excerpt if provided
    if (row.excerpt?.trim()) {
      updateData.excerpt = row.excerpt.trim();
    }

    // Handle ACF JSON
    if (row.acf_json?.trim()) {
      try {
        const acfData = JSON.parse(row.acf_json);
        updateData.acf = acfData;
      } catch (parseError) {
        console.error(`⚠️  Invalid ACF JSON in row ${rowNumber}: ${parseError.message}`);
      }
    }

    // Resolve categories if provided
    if (row.categories?.trim()) {
      const categoryIds = await resolveTerms(row.categories, 'categories', currentApi, config);
      if (categoryIds.length > 0) {
        updateData.categories = categoryIds;
      }
    }

    // Resolve tags if provided
    if (row.tags?.trim()) {
      const tagIds = await resolveTerms(row.tags, 'tags', currentApi, config);
      if (tagIds.length > 0) {
        updateData.tags = tagIds;
      }
    }

    // Upload featured image if provided
    const imagePath = row.featured_image_path?.trim() || row.featured_image_url?.trim();
    if (imagePath) {
      const mediaId = await uploadMedia(imagePath, currentApi, config);
      if (mediaId) {
        updateData.featured_media = mediaId;
      }
    }

    // Check if there's anything to update
    if (Object.keys(updateData).length === 0) {
      throw new Error('No fields to update. Provide at least one field to update.');
    }

    // Perform the update
    await sleep(config.request_delay_ms);
    const updateResponse = await currentApi.post(`/posts/${postId}`, updateData);
    
    result.action = 'updated';
    result.postId = updateResponse.data.id;
    result.status = updateResponse.data.status;
    const message = `[${rowNumber}] ✅ Updated post ${result.postId}: ${result.title}`;
    console.log(message);
    if (progressCallback) {
      progressCallback({ 
        type: 'success', 
        message, 
        rowNumber, 
        postId: result.postId, 
        title: result.title 
      });
    }
  } catch (error) {
    result.error = error.message;
    if (error.response?.data) {
      result.error = `${error.message}: ${JSON.stringify(error.response.data)}`;
    }
    const errorMessage = `[${rowNumber}] ❌ Failed: ${result.title} - ${result.error}`;
    console.error(errorMessage);
    if (progressCallback) {
      progressCallback({ 
        type: 'error', 
        message: errorMessage, 
        rowNumber, 
        title: result.title, 
        error: result.error 
      });
    }
  }

  return result;
}

/**
 * Main execution
 */
async function main() {
  console.log('🔄 WordPress Bulk Updater\n');
  console.log(`Site: ${WP_SITE}`);
  console.log(`Request Delay: ${REQUEST_DELAY_MS}ms`);

  let csvPath;
  
  if (process.argv[2]) {
    csvPath = process.argv[2];
    console.log(`\nCSV: ${csvPath} (from command-line argument)`);
  } else {
    const suggestedPath = process.env.CSV_PATH || 'posts.csv';
    csvPath = await promptForCsvPath(suggestedPath);
    console.log(`\nCSV: ${csvPath}`);
  }

  const isConnected = await checkConnectivity();
  if (!isConnected) {
    process.exit(1);
  }

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
    console.error(`   - Or pass as argument: npm run update "C:\\path\\to\\file.csv"`);
    process.exit(1);
  }

  if (rows.length === 0) {
    console.log('⚠️  CSV file is empty');
    process.exit(0);
  }

  console.log('📤 Starting update process...\n');
  for (let i = 0; i < rows.length; i++) {
    const result = await updatePost(rows[i], i + 1, null, api, defaultConfig);
    logResults.push(result);
  }

  const isVercel = process.env.VERCEL || process.env.VERCEL_ENV;
  const logPath = isVercel 
    ? path.join('/tmp', 'update_log.json')
    : path.resolve(__dirname, 'update_log.json');
  fs.writeFileSync(logPath, JSON.stringify(logResults, null, 2));
  console.log(`\n📝 Log written to: ${logPath}`);

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
 * Process CSV file for updates (exported for use by web server)
 */
export async function processUpdateCsvFile(csvPath, progressCallback = null, clientId = null) {
  logResults = [];
  startTime = Date.now();

  // Get client configuration
  const clientConfig = getClientConfig(clientId);
  const clientApi = createApiInstance(clientConfig);

  if (progressCallback) progressCallback({ type: 'info', message: `🔍 Checking WordPress REST API connectivity for ${clientConfig.name}...` });
  const isConnected = await checkConnectivityWithApi(clientApi, clientConfig.wp_site);
  if (!isConnected) {
    throw new Error(`WordPress REST API is not accessible for ${clientConfig.name}. Check your configuration.`);
  }
  if (progressCallback) progressCallback({ type: 'info', message: `✅ WordPress REST API is accessible for ${clientConfig.name}` });

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
  if (progressCallback) progressCallback({ type: 'info', message: '📤 Starting update process...' });

  for (let i = 0; i < rows.length; i++) {
    const result = await updatePost(rows[i], i + 1, progressCallback, clientApi, clientConfig);
    logResults.push(result);
  }

  const isVercel = process.env.VERCEL || process.env.VERCEL_ENV;
  const logPath = isVercel 
    ? path.join('/tmp', 'update_log.json')
    : path.resolve(__dirname, 'update_log.json');
  
  try {
    fs.writeFileSync(logPath, JSON.stringify(logResults, null, 2));
  } catch (error) {
    console.warn('⚠️  Could not write log file:', error.message);
    console.log('📝 Log data:', JSON.stringify(logResults, null, 2));
  }

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
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.includes('bulk-update.js')) {
  main().catch(error => {
    console.error('❌ Fatal error:', error.message);
    process.exit(1);
  });
}

