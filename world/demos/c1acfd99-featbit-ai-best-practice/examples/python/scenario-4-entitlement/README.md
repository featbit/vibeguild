# Scenario 4: AI Application Entitlement Management

## Overview

This example demonstrates subscription-based feature access control:

- **Tiered Access**: Different features for Free/Pro/Enterprise
- **Usage Limits**: Daily limits based on subscription
- **Dynamic Gating**: Change access without code changes
- **Promotions**: Temporary upgrades for marketing campaigns

## Subscription Tiers

| Feature | Free | Pro | Enterprise |
|---------|------|-----|------------|
| Basic Writing | ✅ | ✅ | ✅ |
| Advanced Writing | ❌ | ✅ | ✅ |
| Summary Generation | ❌ | ✅ | ✅ |
| Custom Model | ❌ | ❌ | ✅ |
| Daily Limit | 10 | 100 | Unlimited |

## Feature Flag Setup

### 1. Basic Writing (All tiers)
```yaml
Flag Key: ai-writing-basic
Type: Boolean
Default: true (all users get basic)
```

### 2. Advanced Writing (Pro & Enterprise)
```yaml
Flag Key: ai-writing-advanced
Type: Boolean
Targeting:
  - subscription_tier IN [pro, enterprise]: true
Default: false
```

### 3. Summary Generation (Pro & Enterprise)
```yaml
Flag Key: ai-summary
Type: Boolean
Targeting:
  - subscription_tier IN [pro, enterprise]: true
Default: false
```

### 4. Custom Model (Enterprise only)
```yaml
Flag Key: ai-custom-model
Type: Boolean
Targeting:
  - subscription_tier = enterprise: true
Default: false
```

### 5. Usage Limits
```yaml
Flag Key: ai-usage-limits
Type: JSON
Variations:
  free: { daily_limit: 10, features: ["basic"] }
  pro: { daily_limit: 100, features: ["basic", "advanced", "summary"] }
  enterprise: { daily_limit: -1, features: ["basic", "advanced", "summary", "custom"] }
Targeting:
  - subscription_tier = free → free config
  - subscription_tier = pro → pro config
  - subscription_tier = enterprise → enterprise config
```

## Running

```bash
pip install -r requirements.txt
python entitlement_service.py
```

## Testing

### Create a Free user
```bash
curl -X POST "http://localhost:8003/api/users?user_id=user-001&name=John&email=john@example.com&tier=free"
```

### Check entitlements
```bash
curl http://localhost:8003/api/users/user-001/entitlements
```

### Try to use basic feature (should work)
```bash
curl -X POST http://localhost:8003/api/write \
  -H "Content-Type: application/json" \
  -d '{"user_id": "user-001", "content": "Hello world", "feature_type": "basic"}'
```

### Try to use advanced feature (should fail - Free tier)
```bash
curl -X POST http://localhost:8003/api/write \
  -H "Content-Type: application/json" \
  -d '{"user_id": "user-001", "content": "Hello world", "feature_type": "advanced"}'
```

### Upgrade to Pro
```bash
curl -X PUT "http://localhost:8003/api/users/user-001/subscription?tier=pro"
```

### Now try advanced (should work)
```bash
curl -X POST http://localhost:8003/api/write \
  -H "Content-Type: application/json" \
  -d '{"user_id": "user-001", "content": "Hello world", "feature_type": "advanced"}'
```

### Create promotion
```bash
curl -X POST "http://localhost:8003/api/promotions/upgrade?user_id=user-001&feature=custom&duration_hours=24"
```

## Business Value

### Without Feature Flags
- Hard-coded subscription logic
- Code changes for new tiers
- Slow time-to-market
- Manual user management

### With Feature Flags
- Instant tier changes
- A/B test pricing
- Promotion campaigns in minutes
- Real-time access control

## Integration Patterns

### Frontend Check
```javascript
const entitlements = await fetch('/api/users/me/entitlements');
if (entitlements.features.find(f => f.feature === 'ai-advanced').enabled) {
  // Show advanced UI
}
```

### Backend Guard
```python
@app.post("/api/advanced-feature")
async def advanced_feature(user_id: str):
    user = get_user(user_id)
    if not check_feature_access(user, FLAG_ADVANCED_WRITING).enabled:
        raise HTTPException(403, "Upgrade required")
    # Process feature
```
