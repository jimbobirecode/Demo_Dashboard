import { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';

/**
 * Who is signed in, and the two ways that changes.
 *
 * The cookie is httpOnly, so the only way to know whether a session exists is
 * to ask the API — a 401 on the first call is the normal signed-out path, not
 * an error worth showing.
 */
export function useSession() {
  const [user, setUser] = useState(null);
  const [mustChangePassword, setMustChangePassword] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    api
      .me()
      .then((payload) => {
        if (cancelled) return;
        setUser(payload.user);
        // A temporary-password session survives a reload; the server refuses
        // everything else until it is changed, so the screen must too.
        setMustChangePassword(Boolean(payload.mustChangePassword));
      })
      .catch(() => {
        if (!cancelled) setUser(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (username, password) => {
    const payload = await api.login(username, password);
    setUser(payload.user);
    setMustChangePassword(Boolean(payload.mustChangePassword));
    return payload;
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      setUser(null);
      setMustChangePassword(false);
    }
  }, []);

  const completePasswordChange = useCallback(async (newPassword, currentPassword) => {
    await api.changePassword(newPassword, currentPassword);
    setMustChangePassword(false);
    // The temp-password login carries no club name, so re-read the session.
    const payload = await api.me().catch(() => null);
    if (payload) setUser(payload.user);
  }, []);

  return { user, mustChangePassword, loading, login, logout, completePasswordChange };
}
