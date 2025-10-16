# genai-lite Chat Demo

An interactive web application demonstrating the capabilities of the genai-lite library.

## Overview

A production-ready interactive web application showcasing all capabilities of the genai-lite library. This demo provides a full-featured chat interface with support for multiple AI providers, advanced prompt engineering features, and local model integration.

**What You Can Do:**
- **Chat with Multiple Providers**: OpenAI, Anthropic, Google Gemini, Mistral, and llama.cpp (local)
- **Advanced Prompt Engineering**: 10+ example templates with variable substitution and model-aware features
- **Local Model Tools**: Tokenization, embeddings, and health checks for llama.cpp (no API keys needed)
- **Customize AI Behavior**: System prompts, temperature, reasoning modes, thinking extraction
- **Export & Share**: Download conversations as JSON or copy as Markdown
- **Professional UX**: Persistent settings, responsive design, enhanced error messages

## Features

**Backend:**
- **Multi-Provider Support**: Backend APIs for OpenAI, Anthropic, Google Gemini, Mistral, and llama.cpp
- **Provider Listing**: API endpoint to list all providers with availability status
- **Model Listing**: API endpoint to get models for each provider
- **Chat Completion**: Full chat API with message validation and error handling
- **Settings Support**: Temperature, maxTokens, topP, reasoning, thinking extraction, and more
- **llama.cpp Integration**: Local model support without API keys

**Frontend:**
- **Tab Navigation**: Three main tabs (Chat, Templates, llama.cpp Tools)
- **Settings Sidebar**: Collapsible left sidebar in Chat tab for easy access to all settings
- **Provider Selection**: Switch between AI providers on the fly
- **Model Selection**: Choose from available models for each provider
- **System Prompt**: Optional system message to customize AI behavior and personality
- **Settings Persistence**: Auto-save/restore preferences including active tab and sidebar state
- **Chat Interface**: Interactive message list with auto-scroll and timestamps
- **Message Input**: Text area with Enter to send, Shift+Enter for newline
- **Copy Individual Messages**: Quick-copy button on each message
- **Reasoning Display**: Collapsible sections for reasoning/thinking output
- **Error Handling**: Actionable error messages with troubleshooting hints
- **Loading States**: Animated spinner with smooth transitions
- **Responsive Design**: Works on desktop and mobile devices

**Advanced Features:**
- **10 Example Templates**: Categorized templates (general, code, creative, analysis)
  - Basic greetings, code review, creative writing, problem-solving
  - Translation with few-shot examples, technical docs, data analysis
  - Debugging helper, interview prep, adaptive learning tutor
  - Category filter and template tags for easy discovery
- **Templates as Conversation Starters**: Load templates directly into Chat tab
  - "Open in Chat" button populates system prompt, message input, variables, and settings
  - Templates provide raw content with `{{ variables }}` intact for editing
  - Settings reset to defaults, then apply template's `<META>` configuration
- **Template Rendering Preview**: Demonstrate genai-lite's template engine with `createMessages()`
  - Variable substitution and type-aware editing (string, boolean, number)
  - Shows rendered messages, model context, and settings from `<META>` blocks
- **Model Presets**: Select from built-in genai-lite presets
- **llama.cpp Utilities**: Local model tools (no API keys needed)
  - Tokenization with token counts
  - Server health checks and slot monitoring
  - Embedding generation for semantic search

**Export & Sharing:**
- **Export as JSON**: Download full conversation with metadata
- **Copy as Markdown**: Copy formatted conversation to clipboard
- **Copy Individual Messages**: Quick-copy any message with reasoning

## Prerequisites

- Node.js 20+ installed
- npm or yarn
- At least one LLM provider API key (or use llama.cpp locally without API keys)

## Quick Start

### 1. Install Dependencies

```bash
cd examples/chat-demo
npm install
```

### 2. Configure Environment Variables

```bash
cp .env.example .env
# Edit .env and add your API keys
```

### 3. Run the Application

```bash
npm run dev
```

This will start:
- Backend server on http://localhost:3000
- Frontend dev server on http://localhost:5173

Visit http://localhost:5173 in your browser.

## Available Scripts

- `npm run dev` - Start both frontend and backend in development mode
- `npm run dev:frontend` - Start only the Vite frontend dev server
- `npm run dev:backend` - Start only the Express backend server
- `npm run build` - Build the frontend for production
- `npm run preview` - Preview the production build

## Project Structure

```
examples/chat-demo/
├── server/                 # Express backend
│   ├── index.ts           # Server entry point
│   ├── services/          # Business logic
│   │   └── llm.ts         # LLM service with genai-lite
│   └── routes/            # API endpoints
│       ├── chat.ts        # Chat completion
│       ├── providers.ts   # Provider listing
│       ├── models.ts      # Model listing
│       ├── presets.ts     # Preset listing
│       ├── templates.ts   # Template rendering
│       └── llamacpp.ts    # llama.cpp utilities
├── src/                   # React frontend
│   ├── main.tsx          # React entry point
│   ├── App.tsx           # Root component
│   ├── style.css         # Global styles
│   ├── api/              # API client
│   │   └── client.ts     # Backend API communication
│   ├── components/       # React components
│   │   ├── ChatInterface.tsx    # Main orchestrator with tab navigation
│   │   ├── MessageList.tsx      # Message display with copy buttons
│   │   ├── MessageInput.tsx     # Input field
│   │   ├── ProviderSelector.tsx # Provider/model selection
│   │   ├── SettingsPanel.tsx    # Settings sidebar (collapsible)
│   │   ├── TemplateExamples.tsx # Template rendering with 10 examples
│   │   ├── LlamaCppTools.tsx    # llama.cpp utilities
│   │   └── ErrorDisplay.tsx     # Error display with expandable details
│   ├── data/             # Static data
│   │   └── exampleTemplates.ts  # 10 categorized example templates
│   └── types/            # TypeScript types
│       └── index.ts      # Type definitions
├── package.json          # Dependencies and scripts
├── tsconfig.json         # TypeScript config (frontend)
├── vite.config.ts        # Vite configuration
└── README.md             # This file
```

## Backend API Endpoints

The backend provides the following REST API endpoints:

**GET /api/health**
- Health check endpoint
- Returns server status and timestamp

**GET /api/providers**
- Lists all AI providers with availability status
- Shows which providers have API keys configured

**GET /api/models/:providerId**
- Lists all models for a specific provider
- Returns model details (pricing, context window, capabilities)

**POST /api/chat**
- Sends a message to an LLM
- Request body:
  ```json
  {
    "providerId": "openai",
    "modelId": "gpt-4.1-mini",
    "messages": [{"role": "user", "content": "Hello!"}],
    "settings": {
      "temperature": 0.7,
      "maxTokens": 1000
    }
  }
  ```
- Returns completion with content, reasoning, and usage stats

**GET /api/presets**
- Lists all configured model presets
- Shows available pre-configured model settings

**POST /api/templates/render**
- Renders a template with variables and model context
- Demonstrates genai-lite's `createMessages()` functionality

**GET /api/llamacpp/health**
- Checks llama.cpp server status and slot availability

**POST /api/llamacpp/tokenize**
- Tokenizes text using llama.cpp's tokenizer

**POST /api/llamacpp/embedding**
- Generates vector embeddings for semantic search

## Environment Variables

Create a `.env` file based on `.env.example`:

```bash
# API Keys (at least one required for cloud providers)
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
GEMINI_API_KEY=AIza...
MISTRAL_API_KEY=...

# llama.cpp Configuration (optional)
LLAMACPP_API_BASE_URL=http://localhost:8080

# Server Configuration
PORT=3000
```

## Using llama.cpp (Local Models)

To use local models via llama.cpp:

1. Install llama.cpp and download a GGUF model
2. Start the llama.cpp server:
   ```bash
   llama-server -m /path/to/model.gguf --port 8080
   ```
3. No API key needed - llama.cpp will be available as a provider

**Note:** The app automatically detects your loaded model. When you select llama.cpp,
the model dropdown shows the actual model name from your running server (e.g., "Qwen3-4B-Instruct-2507-IQ4_NL")

## Using the Application

### Chat Tab
1. **Select Provider and Model**: Choose from available AI providers in the top bar
2. **Configure Settings**: Click ◀/▶ to toggle the settings sidebar (temperature, reasoning, etc.)
3. **Send Messages**: Type in the input area and press Enter (Shift+Enter for newline)
4. **View Reasoning**: Click on collapsed reasoning sections to see model's thinking
5. **Copy/Export**: Use 📋 Copy, 💾 Export, or 🗑️ Clear buttons in the top bar

### Templates Tab
1. **Switch to Templates**: Click the "Templates" tab in the header
2. **Select Preset**: Choose a model preset from the dropdown
3. **Pick Template**: Browse 10 example templates across 4 categories
4. **Edit Variables**: Modify template variables (supports strings, booleans, numbers)
5. **Open in Chat**: Click "Open in Chat" to load template into Chat tab as a conversation starter
   - System prompt and message input populate with raw template content (variables intact)
   - Variables and settings from the template are applied
   - You can then edit everything and start chatting normally
6. **Preview (Optional)**: Click "Render Template" to see the rendered output with model context

### llama.cpp Tools Tab
1. **Switch to llama.cpp Tools**: Click the "llama.cpp Tools" tab in the header
2. **Start Server**: `llama-server -m /path/to/model.gguf --port 8080`
3. **Use Tools**: Access tokenization, health checks, and embeddings
4. **No API Keys Needed**: All features work locally without cloud API keys

## Troubleshooting

### Backend Not Starting
- Make sure port 3000 is not in use: `lsof -i :3000`
- Check that all dependencies are installed: `npm install`
- Verify .env file exists with API keys

### Frontend Not Loading
- Verify the backend is running on port 3000
- Check browser console for errors (F12)
- Try clearing browser cache and localStorage
- Ensure you're accessing http://localhost:5173

### CORS Errors
- The Vite dev server proxies API requests to avoid CORS issues
- Make sure you're accessing via http://localhost:5173, not a different port
- Check that backend is running on port 3000

### API Key Errors
The app provides enhanced error messages:
- **Missing API Key**: "Missing or invalid API key for openai. Add your API key to the .env file..."
- **Solution**: Add `OPENAI_API_KEY=your-key` to `.env` and restart server

### llama.cpp Not Working
- **Error**: "llama.cpp server not running..."
- **Solution**: Start server with `llama-server -m /path/to/model.gguf --port 8080`
- Verify server is running: `curl http://localhost:8080/health`

### Rate Limits
- **Error**: "Rate limit exceeded..."
- **Solution**: Wait a few moments or switch to llama.cpp for unlimited local inference

## Contributing

This is a complete example application for the genai-lite library. To contribute improvements:

1. Test thoroughly before submitting changes
2. Maintain code quality and documentation standards
3. Follow the existing code style and patterns
4. Update README if adding new features

## License

Same as genai-lite parent project (MIT)
