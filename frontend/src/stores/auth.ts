import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import axios from 'axios';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000/api';

interface User {
  id: number;
  email: string;
  firstName: string;
  lastName: string;
  role: 'admin' | 'lawyer' | 'secretary';
  organizationId: number;
}

interface AuthStore {
  user: User | null;
  token: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;

  register: (data: {
    organizationName: string;
    email: string;
    password: string;
    firstName: string;
    lastName: string;
    phone?: string;
  }) => Promise<void>;

  login: (email: string, password: string) => Promise<void>;

  logout: () => void;

  checkAuth: () => Promise<void>;

  clearError: () => void;
}

export const useAuthStore = create<AuthStore>()(
  persist(
    (set) => ({
      user: null,
      token: null,
      isAuthenticated: false,
      isLoading: false,
      error: null,

      register: async (data) => {
        set({ isLoading: true, error: null });
        try {
          const response = await axios.post(`${API_BASE_URL}/auth/register`, data);
          const { token, user } = response.data;

          set({
            token,
            user,
            isAuthenticated: true,
            isLoading: false,
          });

          // Set default auth header
          axios.defaults.headers.common['Authorization'] = `Bearer ${token}`;
        } catch (err: any) {
          const message = err.response?.data?.error || 'Registration failed';
          set({ error: message, isLoading: false });
          throw err;
        }
      },

      login: async (email: string, password: string) => {
        set({ isLoading: true, error: null });
        try {
          const response = await axios.post(`${API_BASE_URL}/auth/login`, {
            email,
            password,
          });
          const { token, user } = response.data;

          set({
            token,
            user,
            isAuthenticated: true,
            isLoading: false,
          });

          // Set default auth header
          axios.defaults.headers.common['Authorization'] = `Bearer ${token}`;
        } catch (err: any) {
          const message = err.response?.data?.error || 'Login failed';
          set({ error: message, isLoading: false });
          throw err;
        }
      },

      logout: () => {
        set({
          user: null,
          token: null,
          isAuthenticated: false,
        });
        delete axios.defaults.headers.common['Authorization'];
      },

      checkAuth: async () => {
        const token = localStorage.getItem('auth');
        if (!token) return;

        try {
          set({ isLoading: true });
          const response = await axios.get(`${API_BASE_URL}/auth/me`, {
            headers: { Authorization: `Bearer ${JSON.parse(token).state.token}` },
          });

          set({
            user: response.data.user,
            isAuthenticated: true,
            isLoading: false,
          });

          axios.defaults.headers.common['Authorization'] = `Bearer ${JSON.parse(token).state.token}`;
        } catch (err) {
          set({ isAuthenticated: false, isLoading: false });
        }
      },

      clearError: () => set({ error: null }),
    }),
    {
      name: 'auth',
      partialize: (state) => ({
        token: state.token,
        user: state.user,
        isAuthenticated: state.isAuthenticated,
      }),
    }
  )
);
