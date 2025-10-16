import React from 'react';
import './StatusIndicator.css';

interface StatusIndicatorProps {
  status: 'running' | 'stopped' | 'error' | 'loading' | 'healthy' | 'unhealthy';
  label: string;
}

const StatusIndicator: React.FC<StatusIndicatorProps> = ({ status, label }) => {
  return (
    <div className="status-indicator">
      <span className={`status-dot status-dot-${status}`}></span>
      <span className="status-label">{label}</span>
    </div>
  );
};

export default StatusIndicator;
