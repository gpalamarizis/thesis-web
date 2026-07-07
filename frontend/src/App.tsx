import React from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { useAuthStore } from './stores/auth';
import Layout from './components/Layout';

// Auth Pages
import LoginPage from './pages/auth/LoginPage';
import RegisterPage from './pages/auth/RegisterPage';

// Dashboard
import DashboardPage from './pages/DashboardPage';

// Cases
import CasesListPage from './pages/cases/CasesListPage';
import CaseDetailPage from './pages/cases/CaseDetailPage';
import CreateCasePage from './pages/cases/CreateCasePage';

// Persons
import PersonsPage from './pages/PersonsPage';

// Courts
import CourtsPage from './pages/CourtsPage';

// Finance
import FinancePage from './pages/FinancePage';

// Settings
import SettingsPage from './pages/SettingsPage';
import TeamPage from './pages/team/TeamPage';

// Protected Route wrapper
const ProtectedRoute: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { token, isAuthenticated } = useAuthStore();

  if (!isAuthenticated || !token) {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
};

function App() {
  const { isAuthenticated } = useAuthStore();

  return (
    <Router>
      <Routes>
        {/* Public Routes */}
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />

        {/* Protected Routes */}
        <Route
          path="/"
          element={
            <ProtectedRoute>
              <Layout>
                <DashboardPage />
              </Layout>
            </ProtectedRoute>
          }
        />

        <Route
          path="/cases"
          element={
            <ProtectedRoute>
              <Layout>
                <CasesListPage />
              </Layout>
            </ProtectedRoute>
          }
        />

        <Route
          path="/cases/new"
          element={
            <ProtectedRoute>
              <Layout>
                <CreateCasePage />
              </Layout>
            </ProtectedRoute>
          }
        />

        <Route
          path="/cases/:id"
          element={
            <ProtectedRoute>
              <Layout>
                <CaseDetailPage />
              </Layout>
            </ProtectedRoute>
          }
        />

        <Route
          path="/persons"
          element={
            <ProtectedRoute>
              <Layout>
                <PersonsPage />
              </Layout>
            </ProtectedRoute>
          }
        />

        <Route
          path="/courts"
          element={
            <ProtectedRoute>
              <Layout>
                <CourtsPage />
              </Layout>
            </ProtectedRoute>
          }
        />

        <Route
          path="/finance"
          element={
            <ProtectedRoute>
              <Layout>
                <FinancePage />
              </Layout>
            </ProtectedRoute>
          }
        />

        <Route
          path="/team"
          element={
            <ProtectedRoute>
              <Layout>
                <TeamPage />
              </Layout>
            </ProtectedRoute>
          }
        />

        <Route
          path="/settings"
          element={
            <ProtectedRoute>
              <Layout>
                <SettingsPage />
              </Layout>
            </ProtectedRoute>
          }
        />

        {/* 404 */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Router>
  );
}

export default App;
