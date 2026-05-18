import React from 'react';

// Resize-aware media query check. Used for layout decisions that need to respond to rotation
// or window resize without a remount. Defaults to a 600px breakpoint.
export function useIsMobile(threshold = 600) {
  const [isMobile, setIsMobile] = React.useState(() => {
    if (typeof window === 'undefined') return false;
    return window.innerWidth <= threshold;
  });
  React.useEffect(() => {
    const handler = () => setIsMobile(window.innerWidth <= threshold);
    window.addEventListener('resize', handler);
    window.addEventListener('orientationchange', handler);
    return () => {
      window.removeEventListener('resize', handler);
      window.removeEventListener('orientationchange', handler);
    };
  }, [threshold]);
  return isMobile;
}
