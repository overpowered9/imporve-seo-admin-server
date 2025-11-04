# API Endpoint Testing Guide

## Prerequisites
1. Server running on `http://localhost:3000`
2. Valid API key (9-digit) from database
3. Valid site code (4-digit) from database

---

## 1. Test Content Generation

### Endpoint
`POST /api/v1/generate/active`

### Example Request
```bash
curl -X POST http://localhost:3000/api/v1/generate/active \
  -H "x-api-key: ABC123DEF" \
  -H "x-site-code: XY12" \
  -H "Content-Type: application/json" \
  -d '{
    "seed_keyword": "Digital Marketing Trends 2025",
    "nos_of_words": "1200 to 2400 words",
    "content_lang": "en",
    "title": "Top Digital Marketing Trends to Watch in 2025",
    "voice_tone": "professional",
    "point_of_view": "second_person",
    "call_to_action": "Subscribe to our newsletter for more insights",
    "details_to_include": "Include statistics and case studies"
  }'
```

### Expected Response
```json
{
  "success": true,
  "data": {
    "generation_id": 123,
    "content": "<!-- Generated HTML content -->",
    "meta_title": "Top Digital Marketing Trends to Watch in 2025",
    "meta_description": "Discover the latest digital marketing trends...",
    "promptsUsed": ["introduction", "sections", "conclusion"],
    "generationMetadata": {
      "templatesUsed": [...],
      "promptVersions": {...},
      "processingTime": 5432
    }
  }
}
```

### Database Verification
```sql
-- Check credit deduction
SELECT * FROM credit_balances 
WHERE user_id = <YOUR_USER_ID> AND credit_type = 'content';

-- Check transaction log
SELECT * FROM credit_transactions 
WHERE user_id = <YOUR_USER_ID> 
ORDER BY created_at DESC LIMIT 5;

-- Check generation record
SELECT * FROM user_generations 
WHERE type = 'content' 
ORDER BY created_at DESC LIMIT 1;
```

---

## 2. Test Image Generation

### Endpoint
`POST /api/v1/generate/generateimage`

### Example Request
```bash
curl -X POST http://localhost:3000/api/v1/generate/generateimage \
  -H "x-api-key: ABC123DEF" \
  -H "x-site-code: XY12" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Future of Artificial Intelligence",
    "style": "photorealistic",
    "size": "1024x768"
  }'
```

### Alternative with Custom Prompt
```bash
curl -X POST http://localhost:3000/api/v1/generate/generateimage \
  -H "x-api-key: ABC123DEF" \
  -H "x-site-code: XY12" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "A futuristic cityscape with AI-powered robots, high detail, 8k resolution",
    "style": "photorealistic",
    "size": "1792x1024"
  }'
```

### Expected Response (Mock)
```json
{
  "success": true,
  "data": {
    "generation_id": 456,
    "image_url": "https://placeholder-image-service.com/1024x768/generated-1730764800.jpg",
    "prompt_used": "Professional cover image for article titled: Future of Artificial Intelligence",
    "style": "photorealistic",
    "size": "1024x768",
    "message": "🚧 Mock response - Image generation service to be integrated"
  }
}
```

### Database Verification
```sql
-- Check image credit deduction
SELECT * FROM credit_balances 
WHERE user_id = <YOUR_USER_ID> AND credit_type = 'images';

-- Check transaction
SELECT * FROM credit_transactions 
WHERE credit_type = 'images' 
ORDER BY created_at DESC LIMIT 1;

-- Check generation record
SELECT * FROM user_generations 
WHERE type = 'image' 
ORDER BY created_at DESC LIMIT 1;
```

---

## 3. Test Keyword Generation

### Endpoint
`POST /api/v1/generate/generatekeyword`

### Example Request
```bash
curl -X POST http://localhost:3000/api/v1/generate/generatekeyword \
  -H "x-api-key: ABC123DEF" \
  -H "x-site-code: XY12" \
  -H "Content-Type: application/json" \
  -d '{
    "seed_keyword": "content marketing",
    "niche": "digital marketing",
    "count": 50,
    "include_search_volume": true
  }'
```

### Minimal Request
```bash
curl -X POST http://localhost:3000/api/v1/generate/generatekeyword \
  -H "x-api-key: ABC123DEF" \
  -H "x-site-code: XY12" \
  -H "Content-Type: application/json" \
  -d '{
    "seed_keyword": "SEO optimization"
  }'
```

### Expected Response (Mock)
```json
{
  "success": true,
  "data": {
    "generation_id": 789,
    "seed_keyword": "content marketing",
    "keywords": [
      {
        "keyword": "content marketing guide 1",
        "search_volume": 5432,
        "difficulty": 67,
        "cpc": "2.34"
      },
      {
        "keyword": "content marketing tips 2",
        "search_volume": 3210,
        "difficulty": 45,
        "cpc": "1.87"
      },
      // ... 48 more keywords
    ],
    "total_count": 50,
    "message": "🚧 Mock response - Keyword research service to be integrated"
  }
}
```

### Database Verification
```sql
-- Check keyword credit deduction
SELECT * FROM credit_balances 
WHERE user_id = <YOUR_USER_ID> AND credit_type = 'keywords';

-- Check transaction
SELECT * FROM credit_transactions 
WHERE credit_type = 'keywords' 
ORDER BY created_at DESC LIMIT 1;

-- Check generation record
SELECT 
  id,
  type,
  status,
  parameters->>'seed_keyword' as seed_keyword,
  (result->'keywords') as keywords_json,
  created_at
FROM user_generations 
WHERE type = 'keywords' 
ORDER BY created_at DESC LIMIT 1;
```

---

## Error Scenarios

### 1. Insufficient Credits
```bash
curl -X POST http://localhost:3000/api/v1/generate/active \
  -H "x-api-key: ABC123DEF" \
  -H "x-site-code: XY12" \
  -H "Content-Type: application/json" \
  -d '{"seed_keyword": "test"}'
```

**Response (if content credits = 0):**
```json
{
  "success": false,
  "error": "Insufficient content credits. Required: 1, Available: 0"
}
```

### 2. Invalid API Key
```bash
curl -X POST http://localhost:3000/api/v1/generate/active \
  -H "x-api-key: INVALID_KEY" \
  -H "x-site-code: XY12" \
  -H "Content-Type: application/json" \
  -d '{"seed_keyword": "test"}'
```

**Response:**
```json
{
  "success": false,
  "error": "Invalid API credentials"
}
```

### 3. Invalid Site Code
```bash
curl -X POST http://localhost:3000/api/v1/generate/active \
  -H "x-api-key: ABC123DEF" \
  -H "x-site-code: WRONG" \
  -H "Content-Type: application/json" \
  -d '{"seed_keyword": "test"}'
```

**Response:**
```json
{
  "success": false,
  "error": "Invalid website code for this API key"
}
```

### 4. Missing Required Parameters
```bash
# Missing seed_keyword
curl -X POST http://localhost:3000/api/v1/generate/active \
  -H "x-api-key: ABC123DEF" \
  -H "x-site-code: XY12" \
  -H "Content-Type: application/json" \
  -d '{}'
```

**Response:**
```json
{
  "success": false,
  "error": "seed_keyword is required"
}
```

---

## Testing with Postman

### 1. Create Environment
```
API_URL: http://localhost:3000
API_KEY: <your-api-key>
SITE_CODE: <your-site-code>
```

### 2. Collection Structure
```
📁 ImproveSEO API
  📁 Generate
    ├─ POST Content (Active)
    ├─ POST Image
    └─ POST Keywords
  📁 Users
    ├─ GET Profile
    └─ GET Credit Balance
  📁 Websites
    ├─ GET All Websites
    └─ POST Add Website
```

### 3. Pre-request Script (Global)
```javascript
// Auto-add headers to all requests
pm.request.headers.add({
  key: 'x-api-key',
  value: pm.environment.get('API_KEY')
});

pm.request.headers.add({
  key: 'x-site-code',
  value: pm.environment.get('SITE_CODE')
});
```

---

## Integration Test Script

Save as `test-generation-flow.sh`:

```bash
#!/bin/bash

API_URL="http://localhost:3000"
API_KEY="YOUR_API_KEY"
SITE_CODE="YOUR_SITE_CODE"

echo "🧪 Testing ImproveSEO API Endpoints"
echo "=================================="

# 1. Test Content Generation
echo ""
echo "1️⃣ Testing Content Generation..."
curl -s -X POST "$API_URL/api/v1/generate/active" \
  -H "x-api-key: $API_KEY" \
  -H "x-site-code: $SITE_CODE" \
  -H "Content-Type: application/json" \
  -d '{
    "seed_keyword": "Test Keyword",
    "nos_of_words": "1200 to 2400 words",
    "title": "Test Article"
  }' | jq '.success, .data.generation_id'

# 2. Test Image Generation
echo ""
echo "2️⃣ Testing Image Generation..."
curl -s -X POST "$API_URL/api/v1/generate/generateimage" \
  -H "x-api-key: $API_KEY" \
  -H "x-site-code: $SITE_CODE" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Test Image"
  }' | jq '.success, .data.generation_id'

# 3. Test Keyword Generation
echo ""
echo "3️⃣ Testing Keyword Generation..."
curl -s -X POST "$API_URL/api/v1/generate/generatekeyword" \
  -H "x-api-key: $API_KEY" \
  -H "x-site-code: $SITE_CODE" \
  -H "Content-Type: application/json" \
  -d '{
    "seed_keyword": "test seo"
  }' | jq '.success, .data.generation_id, .data.total_count'

# 4. Check Credit Balances
echo ""
echo "4️⃣ Checking Credit Balances..."
USER_ID=$(psql -d your_database -t -c "SELECT id FROM users WHERE api_key = '$API_KEY'" | xargs)
psql -d your_database -c "SELECT credit_type, amount FROM credit_balances WHERE user_id = $USER_ID"

echo ""
echo "✅ Test complete!"
```

Make executable:
```bash
chmod +x test-generation-flow.sh
./test-generation-flow.sh
```

---

## WordPress Plugin Testing

### 1. Update Plugin Settings
```php
// wp-admin → ImproveSEO Settings
API Server URL: http://localhost:3000
API Key: ABC123DEF
Site Code: XY12
```

### 2. Test Content Generation
1. Go to WordPress admin
2. Navigate to ImproveSEO → Generate Post
3. Enter keyword and generate
4. Check server logs for API call
5. Verify credit deduction in database

### 3. Test Image Generation
1. Click "Generate AI Image" in post editor
2. Check API call in network tab
3. Verify image URL returned
4. Check database for generation record

---

## Monitoring & Debugging

### Server Logs
```bash
# Watch server logs
tail -f logs/server.log

# Filter for generation events
tail -f logs/server.log | grep "🚀\|✅\|💳"
```

### Database Monitoring
```sql
-- Watch credit transactions in real-time
SELECT * FROM credit_transactions 
ORDER BY created_at DESC 
LIMIT 10;

-- Generation activity
SELECT 
  type,
  status,
  COUNT(*) as count,
  SUM(processing_time_ms) / COUNT(*) as avg_time_ms
FROM user_generations
WHERE created_at >= NOW() - INTERVAL '1 hour'
GROUP BY type, status;
```

---

## Common Issues

### Issue: Credits not deducting
**Solution:** Check `validateCredits` middleware is applied to route

### Issue: Generation saves but no credit deduction
**Solution:** Verify `deductCredits()` is called AFTER successful generation

### Issue: Transaction rollback on error
**Solution:** This is expected behavior - if generation fails, credits shouldn't deduct

### Issue: Mock data in production
**Solution:** Replace mock responses with actual service integrations

---

**Next:** Integrate real Flux AI and keyword research APIs to replace mock responses.
