/**
 * Toasts: a short confirmation that something worked, top-right, gone in a few
 * seconds.
 *
 * For confirmations only. An error stays on the page as a banner, because a
 * message that explains what went wrong must not disappear while it is being
 * read; a toast is for "moved to Booked", which needs no reading at all.
 *
 * `useToast()` outside a provider returns a function that does nothing, so a
 * page rendered alone in a test needs no wrapper.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import Icon from '../components/Icon.jsx';

const ToastContext = createContext(() => {});

/** How long a toast stays. Long enough to read a sentence, short enough to ignore. */
export const TOAST_MS = 4000;

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const nextId = useRef(1);
  const timers = useRef(new Map());

  const dismiss = useCallback((id) => {
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const push = useCallback(
    (text) => {
      const id = nextId.current++;
      // Three at most: a burst of saves should not paper over the page.
      setToasts((current) => [...current.slice(-2), { id, text: String(text) }]);
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), TOAST_MS),
      );
    },
    [dismiss],
  );

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
    };
  }, []);

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toast-viewport" role="status" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className="toast">
            <span className="toast-tick">
              <Icon name="check" size={13} strokeWidth={3} />
            </span>
            <span>{toast.text}</span>
            <button type="button" className="toast-close" aria-label="Dismiss" onClick={() => dismiss(toast.id)}>
              <Icon name="close" size={13} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}
