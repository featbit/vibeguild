"""
Scenario 2: AI Function A/B Testing with Feature Flags

This example demonstrates how to use FeatBit for A/B/n testing of different
AI strategies, collecting metrics for data-driven decision making.

Use case: Testing 3 different AI summary generation strategies
- Strategy A: GPT-4 + Concise prompt
- Strategy B: GPT-4 + Detailed prompt
- Strategy C: Claude-3 + Concise prompt
"""

from fastapi import FastAPI, HTTPException, BackgroundTasks
from pydantic import BaseModel
from typing import Optional, Literal
import logging
import time
import random

# FeatBit SDK imports
from fbclient import get, set_config
from fbclient.config import Config

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="AI Summary A/B Testing API")

# =============================================================================
# FeatBit Configuration
# =============================================================================

ENV_SECRET = "<your-env-secret>"
EVENT_URL = "http://localhost:5100"
STREAMING_URL = "ws://localhost:5100"

config = Config(ENV_SECRET, EVENT_URL, STREAMING_URL)
set_config(config)
fb_client = get()

# Feature Flag Key for A/B test
FLAG_SUMMARY_STRATEGY = "ai-summary-strategy"

# Metric event names (tracked in FeatBit)
METRIC_USER_SATISFACTION = "user_satisfaction_score"
METRIC_ACCURACY = "content_accuracy"
METRIC_RESPONSE_TIME = "api_response_time"

# =============================================================================
# Data Models
# =============================================================================

class SummarizeRequest(BaseModel):
    user_id: str
    content: str
    user_tier: Optional[str] = "free"  # free, pro, enterprise

class SummarizeResponse(BaseModel):
    summary: str
    strategy: str
    model_used: str
    response_time_ms: float
    experiment_id: str

class FeedbackRequest(BaseModel):
    user_id: str
    strategy: str
    satisfaction_score: int  # 1-5
    accuracy: bool  # Was the summary accurate?

# =============================================================================
# AI Strategy Implementations
# =============================================================================

class AIStrategy:
    """Base class for AI strategies"""

    def __init__(self, name: str, model: str, prompt_type: str):
        self.name = name
        self.model = model
        self.prompt_type = prompt_type

    def generate_summary(self, content: str) -> str:
        raise NotImplementedError

class GPT4ConciseStrategy(AIStrategy):
    """Strategy A: GPT-4 with concise prompt"""

    def __init__(self):
        super().__init__("strategy-a", "gpt-4-turbo", "concise")

    def generate_summary(self, content: str) -> str:
        prompt = f"Summarize briefly: {content}"
        # In production, call actual API
        time.sleep(0.5 + random.random() * 0.3)  # Simulate API latency
        return f"[GPT-4 Concise] Key points: {content[:50]}..."

class GPT4DetailedStrategy(AIStrategy):
    """Strategy B: GPT-4 with detailed prompt"""

    def __init__(self):
        super().__init__("strategy-b", "gpt-4-turbo", "detailed")

    def generate_summary(self, content: str) -> str:
        prompt = f"""Please provide a comprehensive summary of the following content.
        Include main points, key details, and important context.

        Content: {content}
        """
        # In production, call actual API
        time.sleep(0.8 + random.random() * 0.4)  # Slightly longer
        return f"[GPT-4 Detailed] Comprehensive analysis: {content[:100]}... with context and implications."

class Claude3ConciseStrategy(AIStrategy):
    """Strategy C: Claude-3 with concise prompt"""

    def __init__(self):
        super().__init__("strategy-c", "claude-3-sonnet", "concise")

    def generate_summary(self, content: str) -> str:
        prompt = f"Summarize briefly: {content}"
        # In production, call actual API
        time.sleep(0.6 + random.random() * 0.3)
        return f"[Claude-3 Concise] Summary: {content[:50]}... (with nuanced understanding)"

# Strategy registry
STRATEGIES = {
    "strategy-a": GPT4ConciseStrategy(),
    "strategy-b": GPT4DetailedStrategy(),
    "strategy-c": Claude3ConciseStrategy(),
}

# =============================================================================
# Feature Flag Integration for A/B Testing
# =============================================================================

def get_strategy_for_user(user_id: str, user_tier: str = "free") -> tuple[str, str]:
    """
    Get the A/B test strategy assignment for a user.

    Returns:
        tuple: (strategy_name, reason)
    """
    if not fb_client.initialize:
        logger.warning("FeatBit client not initialized, using default strategy")
        return "strategy-a", "client_not_initialized"

    user = {
        "key": user_id,
        "name": user_id,
        "tier": user_tier,
    }

    # Get the assigned strategy variation
    detail = fb_client.variation_detail(
        FLAG_SUMMARY_STRATEGY,
        user,
        default="strategy-a"
    )

    strategy_name = detail.variation
    logger.info(f"User {user_id} assigned to {strategy_name}, reason: {detail.reason}")

    return strategy_name, detail.reason

def track_experiment_metrics(user_id: str, strategy: str, metrics: dict):
    """
    Track experiment metrics in FeatBit for analysis.
    """
    if not fb_client.initialize:
        return

    user = {"key": user_id, "name": user_id}

    # Track satisfaction score
    if "satisfaction_score" in metrics:
        fb_client.track_metric(
            user,
            METRIC_USER_SATISFACTION,
            metrics["satisfaction_score"]
        )

    # Track accuracy
    if "accuracy" in metrics:
        fb_client.track_metric(
            user,
            METRIC_ACCURACY,
            1.0 if metrics["accuracy"] else 0.0
        )

    # Track response time
    if "response_time_ms" in metrics:
        fb_client.track_metric(
            user,
            METRIC_RESPONSE_TIME,
            metrics["response_time_ms"]
        )

    logger.info(f"Tracked metrics for user {user_id}, strategy {strategy}: {metrics}")

# =============================================================================
# API Endpoints
# =============================================================================

@app.on_event("startup")
async def startup_event():
    if fb_client.initialize:
        logger.info("FeatBit client initialized for A/B testing")
    else:
        logger.warning("FeatBit client not initialized")

@app.on_event("shutdown")
async def shutdown_event():
    fb_client.stop()

@app.post("/api/summarize", response_model=SummarizeResponse)
async def summarize(request: SummarizeRequest):
    """
    Generate summary using the strategy assigned to the user.
    """
    # Get strategy assignment
    strategy_name, reason = get_strategy_for_user(
        request.user_id,
        request.user_tier
    )

    strategy = STRATEGIES.get(strategy_name, STRATEGIES["strategy-a"])

    # Generate summary and measure time
    start_time = time.time()
    summary = strategy.generate_summary(request.content)
    response_time_ms = (time.time() - start_time) * 1000

    # Track response time metric
    track_experiment_metrics(
        request.user_id,
        strategy_name,
        {"response_time_ms": response_time_ms}
    )

    return SummarizeResponse(
        summary=summary,
        strategy=strategy_name,
        model_used=strategy.model,
        response_time_ms=response_time_ms,
        experiment_id=f"exp-{strategy_name}-{request.user_id}"
    )

@app.post("/api/feedback")
async def submit_feedback(request: FeedbackRequest):
    """
    Submit user feedback for A/B test analysis.
    """
    if request.satisfaction_score < 1 or request.satisfaction_score > 5:
        raise HTTPException(status_code=400, detail="Satisfaction score must be 1-5")

    track_experiment_metrics(
        request.user_id,
        request.strategy,
        {
            "satisfaction_score": request.satisfaction_score,
            "accuracy": request.accuracy
        }
    )

    return {
        "status": "recorded",
        "strategy": request.strategy,
        "satisfaction_score": request.satisfaction_score,
        "accuracy": request.accuracy
    }

@app.get("/api/experiment/status")
async def get_experiment_status():
    """
    Get current experiment configuration.
    """
    if not fb_client.initialize:
        return {"status": "featbit_not_initialized"}

    # Get flag details for all strategies
    sample_user = {"key": "test-user", "name": "Test User"}
    detail = fb_client.variation_detail(
        FLAG_SUMMARY_STRATEGY,
        sample_user,
        default="strategy-a"
    )

    return {
        "flag_key": FLAG_SUMMARY_STRATEGY,
        "strategies": list(STRATEGIES.keys()),
        "sample_evaluation": {
            "variation": detail.variation,
            "reason": detail.reason
        }
    }

# =============================================================================
# Running the Application
# =============================================================================

if __name__ == "__main__":
    import uvicorn

    print("""
    ╔══════════════════════════════════════════════════════════════╗
    ║   AI Summary A/B Testing Demo                               ║
    ╠══════════════════════════════════════════════════════════════╣
    ║   Endpoints:                                                 ║
    ║   - POST /api/summarize   - Generate summary                ║
    ║   - POST /api/feedback    - Submit user feedback            ║
    ║   - GET  /api/experiment/status - Check experiment config   ║
    ║                                                              ║
    ║   Strategies being tested:                                   ║
    ║   - strategy-a: GPT-4 + Concise prompt                      ║
    ║   - strategy-b: GPT-4 + Detailed prompt                     ║
    ║   - strategy-c: Claude-3 + Concise prompt                   ║
    ╚══════════════════════════════════════════════════════════════╝
    """)

    uvicorn.run(app, host="0.0.0.0", port=8001)
