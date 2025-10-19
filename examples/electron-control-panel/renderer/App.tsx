import React, { useState } from 'react';
import SystemInfo from './components/SystemInfo';
import ModelManager from './components/ModelManager';
import LlamaServerControl from './components/LlamaServerControl';
import DiffusionServerControl from './components/DiffusionServerControl';
import ResourceMonitor from './components/ResourceMonitor';

type TabName = 'system' | 'models' | 'server' | 'diffusion' | 'resources';

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
        <button
          className={`tab-button ${activeTab === 'diffusion' ? 'active' : ''}`}
          onClick={() => setActiveTab('diffusion')}
        >
          Diffusion Server
        </button>
        <button
          className={`tab-button ${activeTab === 'resources' ? 'active' : ''}`}
          onClick={() => setActiveTab('resources')}
        >
          Resource Monitor
        </button>
      </nav>

      {/* Tab Content */}
      <main className="tab-content">
        <div className={`tab-panel ${activeTab !== 'system' ? 'tab-panel--hidden' : ''}`}>
          <SystemInfo />
        </div>
        <div className={`tab-panel ${activeTab !== 'models' ? 'tab-panel--hidden' : ''}`}>
          <ModelManager />
        </div>
        <div className={`tab-panel ${activeTab !== 'server' ? 'tab-panel--hidden' : ''}`}>
          <LlamaServerControl />
        </div>
        <div className={`tab-panel ${activeTab !== 'diffusion' ? 'tab-panel--hidden' : ''}`}>
          <DiffusionServerControl />
        </div>
        <div className={`tab-panel ${activeTab !== 'resources' ? 'tab-panel--hidden' : ''}`}>
          <ResourceMonitor />
        </div>
      </main>
    </div>
  );
};

export default App;
