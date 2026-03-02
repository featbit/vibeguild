# Scenario 1: AI Model Safe Release

## Overview

This example demonstrates how to use FeatBit Feature Flags to safely release a new AI model (e.g., GPT-4) to replace an existing model (e.g., GPT-3.5) with:

- **Gradual Rollout**: Start with 5% of users, gradually increase
- **Instant Rollback**: One-click disable if issues detected
- **Real-time Updates**: Flag changes take effect immediately
- **Audit Trail**: Track who changed what and when

## Prerequisites

1. FeatBit instance running (see [FeatBit docs](https://docs.featbit.co))
2. Python 3.8+ installed
3. Feature flag `ai-customer-service-v2` created in FeatBit

## Setup

```bash
# Install dependencies
pip install -r requirements.txt

# Set environment variables
export FEATBIT_ENV_SECRET="your-env-secret"
export FEATBIT_EVENT_URL="http://localhost:5100"
export FEATBIT_STREAMING_URL="ws://localhost:5100"
```

## Running

```bash
python fastapi_app.py
```

## Testing

### Check health (FeatBit connection status)
```bash
curl http://localhost:8000/api/health
```

### Send chat message
```bash
curl -X POST http://localhost:8000/api/chat \
  -H "Content-Type: application/json" \
  -d '{
    "user_id": "user-123",
    "message": "Hello, I need help with my order"
  }'
```

### Check flag status for a user
```bash
curl http://localhost:8000/api/flag-status/user-123
```

## Rollout Strategy

1. **Phase 1 (5%)**: Internal testers only
   - Create segment "internal-testers"
   - Target segment with 100% true

2. **Phase 2 (20%)**: Beta users
   - Expand to beta user segment
   - Monitor error rates

3. **Phase 3 (50%)**: General availability
   - Use percentage rollout
   - Monitor user feedback

4. **Phase 4 (100%)**: Full release
   - All users get new model

## Rollback

To instantly rollback, change the flag to `false` in FeatBit dashboard. Changes propagate in < 100ms.
