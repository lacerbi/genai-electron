import React from 'react';
import Spinner from './Spinner';
import './ActionButton.css';

interface ActionButtonProps {
  variant: 'primary' | 'danger' | 'secondary';
  loading?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
  className?: string;
}

const ActionButton: React.FC<ActionButtonProps> = ({
  variant,
  loading = false,
  disabled = false,
  onClick,
  children,
  className = '',
}) => {
  const isDisabled = disabled || loading;

  return (
    <button
      className={`action-button action-button-${variant} ${className}`}
      onClick={onClick}
      disabled={isDisabled}
    >
      {loading && <Spinner size="small" inline />}
      <span className={loading ? 'button-text-loading' : ''}>{children}</span>
    </button>
  );
};

export default ActionButton;
