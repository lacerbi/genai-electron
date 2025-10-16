import React from 'react';
import './Spinner.css';

interface SpinnerProps {
  size?: 'small' | 'medium' | 'large';
  inline?: boolean;
}

const Spinner: React.FC<SpinnerProps> = ({ size = 'medium', inline = false }) => {
  return (
    <div
      className={`spinner spinner-${size} ${inline ? 'spinner-inline' : ''}`}
      role="status"
      aria-label="Loading"
    >
      <div className="spinner-circle"></div>
    </div>
  );
};

export default Spinner;
