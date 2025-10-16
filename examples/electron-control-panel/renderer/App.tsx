import React, { useState } from 'react';
import SystemInfo from './components/SystemInfo';
import ModelManager from './components/ModelManager';
import LlamaServerControl from './components/LlamaServerControl';

type TabName = 'system' | 'models' | 'server';

const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<TabName>('system');

  return (
    <div className="app">
      {/* Header */}
      <header className="app-header">
        <h1>genai-electron Control Panel</h1>
        <p className="subtitle">Developer tool for local AI infrastructure management</p>
      </header>

      {/* Tab Navigation */}
      <nav className="tab-nav">
        <button
          className={`tab-button ${activeTab === 'system' ? 'active' : ''}`}
          onClick={() => setActiveTab('system')}
        >
          System Info
        </button>
        <button
          className={`tab-button ${activeTab === 'models' ? 'active' : ''}`}
          onClick={() => setActiveTab('models')}
        >
          Models
        </button>
        <button
          className={`tab-button ${activeTab === 'server' ? 'active' : ''}`}
          onClick={() => setActiveTab('server')}
        >
          LLM Server
        </button>
      </nav>

      {/* Tab Content */}
      <main className="tab-content">
        {activeTab === 'system' && <SystemInfo />}
        {activeTab === 'models' && <ModelManager />}
        {activeTab === 'server' && <LlamaServerControl />}
      </main>
    </div>
  );
};

export default App;
