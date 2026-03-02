# Scenario 3: AI Function Remote Configuration

## Overview

This example demonstrates dynamic AI configuration using FeatBit:

- **Temperature**: Control output creativity vs accuracy
- **Max Tokens**: Control response length
- **System Prompt**: Adjust model behavior
- **Fallback Model**: Backup when primary fails
- **Rate Limits**: Per-user usage control
- **Cost Thresholds**: Alert on high costs

All changes take effect **in real-time** without redeployment!

## Configuration Structure

```json
{
  "model": "gpt-4-turbo",
  "temperature": 0.7,
  "max_tokens": 2000,
  "system_prompt": "You are a helpful assistant.",
  "fallback_model": "gpt-3.5-turbo",
  "rate_limit_per_user": 100,
  "cost_alert_threshold": 0.05,
  "enable_streaming": true,
  "safety_filters": ["hate_speech", "violence"]
}
```

## Setup

### Create the Feature Flag

1. In FeatBit, create a **JSON** type flag: `ai-config`
2. Add variations for different environments:
   - `production`: Conservative settings
   - `development`: More experimental settings
3. Configure targeting by environment

## Running

```bash
pip install -r requirements.txt
python ai_service.py
```

## Testing

### Get current configuration
```bash
curl http://localhost:8002/api/config
```

### Send chat message
```bash
curl -X POST http://localhost:8002/api/chat \
  -H "Content-Type: application/json" \
  -d '{"user_id": "user-001", "message": "Hello!"}'
```

### Override config for testing
```bash
curl -X POST http://localhost:8002/api/chat \
  -H "Content-Type: application/json" \
  -d '{
    "user_id": "test-user",
    "message": "Hello!",
    "override_config": {
      "temperature": 0.9,
      "model": "gpt-3.5-turbo"
    }
  }'
```

### Validate a config change
```bash
curl -X POST http://localhost:8002/api/config/validate \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4",
    "temperature": 0.8,
    "max_tokens": 1500,
    "system_prompt": "You are a test assistant.",
    "fallback_model": "gpt-3.5-turbo",
    "rate_limit_per_user": 50,
    "cost_alert_threshold": 0.02,
    "enable_streaming": true,
    "safety_filters": []
  }'
```

### Check user usage
```bash
curl http://localhost:8002/api/usage/user-001
```

## Real-time Updates

When you change the flag in FeatBit:
1. SDK receives update via WebSocket (< 100ms)
2. Configuration change listener fires
3. New config is applied immediately
4. All subsequent requests use new config

## Use Cases

### Tune for accuracy
```json
{
  "temperature": 0.3,
  "system_prompt": "Provide factual, concise answers."
}
```

### Tune for creativity
```json
{
  "temperature": 1.2,
  "system_prompt": "Be creative and explore unique perspectives."
}
```

### Emergency cost control
```json
{
  "model": "gpt-3.5-turbo",
  "max_tokens": 500,
  "rate_limit_per_user": 20
}
```

### A/B test prompts
```json
{
  "system_prompt": "You are an expert in [specific domain]."
}
```
