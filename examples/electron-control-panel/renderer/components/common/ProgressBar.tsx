import React from 'react';
import './ProgressBar.css';

interface ProgressBarProps {
  current: number;
  total: number;
  showPercentage?: boolean;
  label?: string;
  className?: string;
}

const ProgressBar: React.FC<ProgressBarProps> = ({
  current,
  total,
  showPercentage = true,
  label,
  className = '',
}) => {
  const percentage = total > 0 ? Math.round((current / total) * 100) : 0;

  return (
    <div className={`progress-bar-container ${className}`}>
      {label && <div className="progress-label">{label}</div>}
      <div className="progress-bar-wrapper">
        <div className="progress-bar-track">
          <div className="progress-bar-fill" style={{ width: `${percentage}%` }}></div>
        </div>
        {showPercentage && <span className="progress-percentage">{percentage}%</span>}
      </div>
    </div>
  );
};

export default ProgressBar;
