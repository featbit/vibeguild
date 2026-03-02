# Scenario 2: AI Function A/B Testing

## Overview

This example demonstrates A/B/n testing for AI strategies using FeatBit:

- **Multi-variant testing**: Test 3+ strategies simultaneously
- **Consistent user assignment**: Same user always gets same strategy
- **Metric tracking**: Collect satisfaction, accuracy, response time
- **Data-driven decisions**: Let metrics determine the winner

## Test Setup

### Create the Feature Flag

1. In FeatBit, create a **String** type flag: `ai-summary-strategy`
2. Add 3 variations:
   - `strategy-a`: GPT-4 + Concise prompt
   - `strategy-b`: GPT-4 + Detailed prompt
   - `strategy-c`: Claude-3 + Concise prompt
3. Configure percentage rollout:
   - strategy-a: 33.3%
   - strategy-b: 33.3%
   - strategy-c: 33.4%

### Create Metrics

In FeatBit Experiments section:
1. **User Satisfaction** (Numeric 1-5)
2. **Content Accuracy** (Conversion)
3. **Response Time** (Numeric in ms)

## Running

```bash
pip install -r requirements.txt
python app.py
```

## Testing the A/B Test

### Generate summaries (different users get different strategies)
```bash
# User 1
curl -X POST http://localhost:8001/api/summarize \
  -H "Content-Type: application/json" \
  -d '{"user_id": "user-001", "content": "Long article content here..."}'

# User 2
curl -X POST http://localhost:8001/api/summarize \
  -H "Content-Type: application/json" \
  -d '{"user_id": "user-002", "content": "Another article..."}'
```

### Submit feedback
```bash
curl -X POST http://localhost:8001/api/feedback \
  -H "Content-Type: application/json" \
  -d '{
    "user_id": "user-001",
    "strategy": "strategy-a",
    "satisfaction_score": 4,
    "accuracy": true
  }'
```

## Analyzing Results

After collecting data:
1. Go to FeatBit → Experiments
2. View the experiment results
3. Compare metrics across strategies:
   - Average satisfaction score
   - Accuracy rate
   - Average response time
4. Identify the winning strategy based on your criteria

## Best Practices

1. **Run long enough**: Collect statistically significant data
2. **Monitor all metrics**: Don't optimize for just one
3. **Consider costs**: Factor in API costs per strategy
4. **Document findings**: Keep records of what worked and why
