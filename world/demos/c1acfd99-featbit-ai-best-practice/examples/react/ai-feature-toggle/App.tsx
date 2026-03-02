/**
 * React AI Feature Toggle Example
 *
 * This example demonstrates how to use FeatBit React SDK to toggle
 * AI features in a React application.
 */

import React from 'react';
import { createRoot } from 'react-dom/client';
import {
  asyncWithFbProvider,
  useFlags,
  useFbClient
} from '@featbit/react-client-sdk';

// =============================================================================
// Types
// =============================================================================

interface AIConfig {
  model: string;
  temperature: number;
  maxTokens: number;
  systemPrompt: string;
}

interface User {
  keyId: string;
  name: string;
  tier: 'free' | 'pro' | 'enterprise';
}

// =============================================================================
// Feature Flag Configuration
// =============================================================================

const FB_CONFIG = {
  options: {
    sdkKey: process.env.REACT_APP_FEATBIT_SDK_KEY || '<your-sdk-key>',
    streamingUrl: process.env.REACT_APP_FEATBIT_STREAMING_URL || 'wss://app-eval.featbit.co',
    eventsUrl: process.env.REACT_APP_FEATBIT_EVENTS_URL || 'https://app-eval.featbit.co',
    user: {
      keyId: 'demo-user',
      name: 'Demo User',
      customizedProperties: [
        { name: 'tier', value: 'pro' }
      ]
    }
  }
};

// =============================================================================
// Components
// =============================================================================

/**
 * Main App Component
 */
function App() {
  const flags = useFlags();
  const fbClient = useFbClient();

  // Access feature flags using bracket notation
  const aiAssistantEnabled = flags['ai-assistant-enabled'];
  const aiAdvancedFeatures = flags['ai-advanced-features'];
  const aiConfig = flags['ai-config'] as AIConfig;

  return (
    <div className="app">
      <header className="app-header">
        <h1>🤖 AI Feature Toggle Demo</h1>
        <p>Real-time feature control with FeatBit</p>
      </header>

      <main className="app-main">
        {/* Feature Status Panel */}
        <section className="feature-status">
          <h2>Feature Status</h2>
          <div className="status-grid">
            <StatusCard
              title="AI Assistant"
              enabled={aiAssistantEnabled}
              description="Basic AI chat functionality"
            />
            <StatusCard
              title="Advanced Features"
              enabled={aiAdvancedFeatures}
              description="Advanced AI capabilities"
            />
          </div>
        </section>

        {/* AI Assistant Component */}
        {aiAssistantEnabled ? (
          <AIAssistant
            config={aiConfig}
            advancedEnabled={aiAdvancedFeatures}
          />
        ) : (
          <div className="feature-disabled">
            <h3>AI Assistant Disabled</h3>
            <p>Enable the feature flag in FeatBit to see the AI assistant.</p>
          </div>
        )}

        {/* Debug Panel */}
        <section className="debug-panel">
          <h2>Debug Information</h2>
          <pre>{JSON.stringify(flags, null, 2)}</pre>
        </section>
      </main>
    </div>
  );
}

/**
 * Status Card Component
 */
function StatusCard({ title, enabled, description }: {
  title: string;
  enabled: boolean;
  description: string;
}) {
  return (
    <div className={`status-card ${enabled ? 'enabled' : 'disabled'}`}>
      <div className="status-indicator">
        {enabled ? '✅' : '❌'}
      </div>
      <h3>{title}</h3>
      <p>{description}</p>
      <span className="status-label">
        {enabled ? 'Enabled' : 'Disabled'}
      </span>
    </div>
  );
}

/**
 * AI Assistant Component
 */
function AIAssistant({ config, advancedEnabled }: {
  config?: AIConfig;
  advancedEnabled?: boolean;
}) {
  const [input, setInput] = React.useState('');
  const [response, setResponse] = React.useState('');
  const [loading, setLoading] = React.useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim()) return;

    setLoading(true);
    try {
      // In production, this would call your AI API
      await new Promise(resolve => setTimeout(resolve, 1000));
      setResponse(`AI Response to: "${input}"\n\nUsing config: ${JSON.stringify(config, null, 2)}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="ai-assistant">
      <h2>AI Assistant</h2>

      {advancedEnabled && (
        <div className="advanced-features">
          <h4>🌟 Advanced Features Active</h4>
          <ul>
            <li>Enhanced context understanding</li>
            <li>Multi-turn conversations</li>
            <li>Custom model tuning</li>
          </ul>
        </div>
      )}

      <div className="config-display">
        <h4>Current Configuration</h4>
        <pre>{JSON.stringify(config, null, 2)}</pre>
      </div>

      <form onSubmit={handleSubmit} className="chat-form">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Type your message..."
          rows={3}
        />
        <button type="submit" disabled={loading}>
          {loading ? 'Processing...' : 'Send'}
        </button>
      </form>

      {response && (
        <div className="response">
          <h4>Response:</h4>
          <pre>{response}</pre>
        </div>
      )}
    </section>
  );
}

// =============================================================================
// Styles (inline for demo purposes)
// =============================================================================

const styles = `
  .app {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
    max-width: 1200px;
    margin: 0 auto;
    padding: 20px;
  }

  .app-header {
    text-align: center;
    margin-bottom: 30px;
  }

  .feature-status {
    margin-bottom: 30px;
  }

  .status-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 20px;
  }

  .status-card {
    padding: 20px;
    border-radius: 8px;
    border: 1px solid #ddd;
  }

  .status-card.enabled {
    background: #e8f5e9;
    border-color: #4caf50;
  }

  .status-card.disabled {
    background: #ffebee;
    border-color: #f44336;
  }

  .status-indicator {
    font-size: 24px;
    margin-bottom: 10px;
  }

  .ai-assistant {
    background: #f5f5f5;
    padding: 20px;
    border-radius: 8px;
    margin-bottom: 20px;
  }

  .advanced-features {
    background: #e3f2fd;
    padding: 15px;
    border-radius: 8px;
    margin-bottom: 15px;
  }

  .chat-form {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .chat-form textarea {
    padding: 10px;
    border: 1px solid #ddd;
    border-radius: 4px;
    font-size: 16px;
  }

  .chat-form button {
    padding: 12px 24px;
    background: #2196f3;
    color: white;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 16px;
  }

  .chat-form button:disabled {
    background: #bbb;
    cursor: not-allowed;
  }

  .feature-disabled {
    text-align: center;
    padding: 40px;
    background: #fafafa;
    border-radius: 8px;
    margin-bottom: 20px;
  }

  .debug-panel {
    background: #263238;
    color: #aed581;
    padding: 20px;
    border-radius: 8px;
  }

  .debug-panel pre {
    margin: 0;
    overflow-x: auto;
  }
`;

// =============================================================================
// Initialize Application
// =============================================================================

async function initApp() {
  // Inject styles
  const styleElement = document.createElement('style');
  styleElement.textContent = styles;
  document.head.appendChild(styleElement);

  // Initialize FeatBit Provider
  const Provider = await asyncWithFbProvider(FB_CONFIG);

  // Render app
  const root = createRoot(document.getElementById('root')!);
  root.render(
    <Provider>
      <App />
    </Provider>
  );
}

initApp().catch(console.error);

export default App;
