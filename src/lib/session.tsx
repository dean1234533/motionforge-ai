import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { api } from './api';

export interface User {
  id: string;
  email: string;
  plan: string;
}

interface Session {
  user: User | null;
  credits: number;
  loading: boolean;
  setCredits: (n: number) => void;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

const Ctx = createContext<Session>({ user: null, credits: 0, loading: false, setCredits: () => undefined, refresh: async () => undefined, logout: async () => undefined });

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [credits, setCredits] = useState(0);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const me = await api<{ user?: User; credits?: number } | null>('GET', '/api/me');
      if (me?.user) {
        setUser(me.user);
        setCredits(me.credits ?? 0);
      } else {
        setUser(null);
      }
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      await api('POST', '/api/auth/logout', {});
    } finally {
      setUser(null);
      setCredits(0);
      window.location.hash = '#/';
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo(() => ({ user, credits, loading, setCredits, refresh, logout }), [user, credits, loading, refresh, logout]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useSession = () => useContext(Ctx);
