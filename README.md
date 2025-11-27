# WordPress Bulk Blog Uploader

A production-ready Node.js command-line tool that reads a CSV file of blog posts and uploads them to a WordPress site via the REST API.

## Features

- ✅ **Web Interface** - Easy-to-use browser-based upload interface
- ✅ **Command-Line Tool** - Traditional CLI for automation
- ✅ **Bulk Upload** - Create new posts from CSV
- ✅ **Bulk Update** - Update existing posts from CSV (NEW!)
- ✅ Idempotent operations (update if slug exists, else create)
- ✅ Automatic category/tag creation
- ✅ Featured image upload support (local files and URLs)
- ✅ ACF (Advanced Custom Fields) support
- ✅ Rate limiting to avoid throttling
- ✅ Comprehensive logging
- ✅ Error handling and recovery

## Prerequisites

- Node.js 20 or higher
- WordPress site with REST API enabled
- WordPress Application Password (see setup below)

## Installation

1. Clone or download this repository
2. Install dependencies:

```bash
npm install
```

3. Copy `.env.example` to `.env` and fill in your WordPress credentials:

```bash
cp .env.example .env
```

## WordPress Application Password Setup

1. Log in to your WordPress admin dashboard
2. Go to **Users** → **Profile** (or **Users** → **All Users** → select your user)
3. Scroll down to **Application Passwords** section
4. Enter a name (e.g., "Bulk Uploader") and click **Add New Application Password**
5. Copy the generated password (it will look like: `xxxx xxxx xxxx xxxx xxxx xxxx`)
6. Paste it into your `.env` file as `WP_APP_PASSWORD`

**Important:** The application password is shown only once. Save it immediately.

## Configuration

Edit your `.env` file:

```env
# WordPress Site Configuration
WP_SITE=https://your-site.com          # Your WordPress site URL (no trailing slash)
WP_USER=your_username                  # Your WordPress username
WP_APP_PASSWORD=xxxx xxxx xxxx...      # Application password from WordPress

# CSV Configuration
CSV_PATH=posts.csv                     # Path to your CSV file
DEFAULT_STATUS=draft                   # Default status for posts (draft|publish|private|pending)
REQUEST_DELAY_MS=300                   # Delay between requests in milliseconds

# Server Configuration
PORT=3000                              # Port for web interface (default: 3000)

# Web Interface Authentication (REQUIRED for security)
AUTH_USERNAME=admin                    # Username for web interface login
AUTH_PASSWORD=change-this-to-secure    # Password for web interface login (use strong password!)
```

**Important Security Note:** 
- **Always set `AUTH_USERNAME` and `AUTH_PASSWORD`** in your `.env` file to protect the web interface
- Use strong passwords to prevent unauthorized access
- Never commit your `.env` file to version control
- Default credentials (admin/admin123) are only used if not set, and a warning will be displayed

## CSV Format

### For Uploading (Creating New Posts)

Your CSV file should have the following columns:

#### Required Columns

- `title` - Post title (required)
- `content` - Post content, HTML allowed (required)

#### Optional Columns

- `status` - Post status: `draft`, `publish`, `private`, or `pending` (defaults to `DEFAULT_STATUS` from `.env`)
- `categories` - Comma-separated category names (e.g., "Tutorials,WordPress")
- `tags` - Comma-separated tag names (e.g., "beginner,guide")
- `slug` - Custom URL slug (if not provided, WordPress will generate one)
- `excerpt` - Post excerpt
- `featured_image_path` - Local file path to featured image (relative to script directory)
- `featured_image_url` - URL to featured image (alternative to `featured_image_path`)
- `acf_json` - JSON string for ACF fields (e.g., `{"field_name": "value"}`)

#### Example Upload CSV

```csv
title,content,status,categories,tags,slug,excerpt,featured_image_path,acf_json
"My First Post","<p>This is the content.</p>",draft,"Tutorials",beginner,my-first-post,"A great post",,
"Another Post","<p>More content here.</p>",publish,"News,Updates",news,another-post,"Another great post",images/featured.jpg,"{""author"": ""John Doe""}"
```

### For Updating (Existing Posts)

When updating posts, you need to identify which post to update. You can use one of these identifiers:

#### Required: Post Identifier (choose one)

- `post_id` - WordPress post ID (most reliable)
- `slug` - Post slug/permalink
- `title` - Post title (must match exactly)

#### Optional: Fields to Update

Only include the fields you want to update. Fields not included will remain unchanged:

- `title` - Update post title
- `content` - Update post content
- `status` - Update post status
- `slug` - Update post slug
- `excerpt` - Update post excerpt
- `categories` - Update categories (comma-separated)
- `tags` - Update tags (comma-separated)
- `featured_image_path` - Update featured image (local path)
- `featured_image_url` - Update featured image (URL)
- `acf_json` - Update ACF fields (JSON string)

#### Example Update CSV

```csv
post_id,title,content,status,categories
123,"Updated Title","<p>Updated content here.</p>",publish,"Tutorials,WordPress"
,,"<p>Only updating content for this post</p>,,,"News"
456,,,draft,
```

**Note:** In the update CSV:
- Row 1: Updates post ID 123 with new title, content, status, and categories
- Row 2: Updates post by slug (empty post_id) - only updates content and categories
- Row 3: Updates post ID 456 - only changes status to draft (other fields unchanged)

## Usage

### Web Interface (Recommended for Non-Technical Users)

1. Start the web server:

```bash
npm run server
# or
npm start
```

2. Open your browser and navigate to: `http://localhost:3000`
3. Choose your mode:
   - **Create New Posts** - For uploading new blog posts
   - **Update Existing Posts** - For updating existing blog posts
4. Click "Choose CSV File" and select your CSV file
5. Click "Upload & Process" or "Update & Process" (depending on mode)
6. View results in the browser

### Command-Line Interface

#### Uploading New Posts

1. Prepare your CSV file (see format above)
2. Run the uploader:

```bash
npm run upload
```

The script will prompt you for the CSV file path, or you can provide it as an argument:

```bash
npm run upload "C:\path\to\your\file.csv"
```

#### Updating Existing Posts

1. Prepare your CSV file with post identifiers and fields to update (see format above)
2. Run the updater:

```bash
npm run update
```

Or provide the CSV path as an argument:

```bash
npm run update "C:\path\to\your\update-file.csv"
```

Both scripts will:
1. Check WordPress REST API connectivity
2. Load and parse your CSV file
3. Process each row (create/update posts, upload images, create terms)
4. Display progress in the console
5. Generate log files (`import_log.json` for uploads, `update_log.json` for updates) with detailed results

## Output

### Console Output

The script provides real-time progress:

```
🚀 WordPress Bulk Uploader

Site: https://example.com
CSV: posts.csv
Default Status: draft
Request Delay: 300ms

🔍 Checking WordPress REST API connectivity...
✅ WordPress REST API is accessible

📖 Loading CSV: posts.csv...
✅ Loaded 3 row(s)

📤 Starting upload process...

[1] ✅ created post 123: Getting Started with WordPress
[2] ✅ updated post 124: Advanced SEO Tips
[3] ❌ failed: Sample Post - Missing required field: content

📝 Log written to: import_log.json

==================================================
📊 Summary
==================================================
✅ Success: 2
❌ Failed: 1
⏱️  Total Time: 5.23s
==================================================
```

### Log File

`import_log.json` contains detailed results for each row:

```json
[
  {
    "rowNumber": 1,
    "title": "Getting Started with WordPress",
    "action": "created",
    "postId": 123,
    "status": "draft",
    "error": null
  },
  {
    "rowNumber": 2,
    "title": "Advanced SEO Tips",
    "action": "updated",
    "postId": 124,
    "status": "publish",
    "error": null
  }
]
```

## Troubleshooting

### 401 Unauthorized

**Problem:** Authentication failed

**Solutions:**
- Verify `WP_USER` matches your WordPress username exactly
- Check that `WP_APP_PASSWORD` is correct (no extra spaces)
- Ensure you're using an Application Password, not your regular WordPress password
- Make sure the Application Password hasn't been revoked in WordPress

### 403 Forbidden (REST API Blocked)

**Problem:** WordPress REST API is disabled or blocked

**Solutions:**
- Check if REST API is enabled in WordPress (it should be by default)
- Disable security plugins temporarily to test
- Check `.htaccess` or server configuration for REST API blocks
- Verify your WordPress version supports REST API (WordPress 4.7+)

### Media Upload Errors

**Problem:** Featured images fail to upload

**Solutions:**
- Verify the file path in `featured_image_path` is correct (relative to script directory)
- Check file permissions (script must be able to read the image file)
- Ensure the file format is supported by WordPress (jpg, png, gif, etc.)
- Check WordPress media upload limits (file size, dimensions)
- Verify your user has permission to upload media

### Rate Limits / Timeouts

**Problem:** Requests are being throttled or timing out

**Solutions:**
- Increase `REQUEST_DELAY_MS` in `.env` (try 500, 1000, or higher)
- Check if your hosting provider has rate limits
- Verify WordPress security plugins aren't blocking requests
- Check network connectivity and WordPress site performance

### Connection Errors

**Problem:** Cannot reach WordPress site

**Solutions:**
- Verify `WP_SITE` URL is correct (no trailing slash, include `https://`)
- Check if the site is accessible from your network
- Verify SSL certificate is valid (if using HTTPS)
- Check firewall or VPN settings

### CSV Parsing Errors

**Problem:** CSV file not loading correctly

**Solutions:**
- Ensure CSV is UTF-8 encoded
- Check that required columns (`title`, `content`) are present
- Verify CSV format (proper commas, quoted strings if containing commas)
- Check file path in `CSV_PATH` is correct

## How It Works

### Idempotency

If a `slug` is provided in the CSV:
- The script searches for an existing post with that slug
- If found → updates the existing post
- If not found → creates a new post

If no `slug` is provided:
- Always creates a new post

### Term Resolution

For categories and tags:
1. Search for existing term by name
2. If found → use existing term ID
3. If not found → create new term and use new ID

### Rate Limiting

The script waits `REQUEST_DELAY_MS` milliseconds between write operations (create/update posts, create terms, upload media) to avoid overwhelming the server or triggering rate limits.

## Security Notes

- Never commit your `.env` file to version control
- Application Passwords can be revoked in WordPress at any time
- The script uses Basic Authentication over HTTPS (ensure your site uses SSL)
- Passwords are never printed in logs or console output

## License

MIT

## Support

For issues or questions:
1. Check the troubleshooting section above
2. Review `import_log.json` for detailed error messages
3. Verify your WordPress REST API is accessible: `https://your-site.com/wp-json/wp/v2/posts`

