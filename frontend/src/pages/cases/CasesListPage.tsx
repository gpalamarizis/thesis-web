import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import { Plus, Search, Filter, FileText, AlertCircle } from 'lucide-react';

interface Case {
  id: number;
  protocol_number: string;
  description: string;
  status: string;
  starting_date: string;
  client_name: string;
  opposing_lawyer_name: string;
  created_at: string;
}

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000/api';

export default function CasesListPage() {
  const navigate = useNavigate();
  const [cases, setCases] = useState<Case[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [page, setPage] = useState(1);

  useEffect(() => {
    fetchCases();
  }, [search, statusFilter, page]);

  const fetchCases = async () => {
    try {
      setIsLoading(true);
      const params = new URLSearchParams();
      if (search) params.append('search', search);
      if (statusFilter) params.append('status', statusFilter);
      params.append('page', page.toString());

      const response = await axios.get(`${API_BASE_URL}/cases?${params}`);
      setCases(response.data.data);
      setError('');
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to load cases');
    } finally {
      setIsLoading(false);
    }
  };

  const statusColors = {
    open: 'bg-blue-100 text-blue-800',
    closed: 'bg-green-100 text-green-800',
    pending: 'bg-yellow-100 text-yellow-800',
    archived: 'bg-gray-100 text-gray-800',
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-slate-900">Cases</h1>
          <p className="text-slate-600 mt-1">Manage your legal cases</p>
        </div>
        <button
          onClick={() => navigate('/cases/new')}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition"
        >
          <Plus className="w-5 h-5" />
          New Case
        </button>
      </div>

      {/* Filters */}
      <div className="bg-white rounded-lg shadow p-4 flex gap-4">
        <div className="flex-1">
          <div className="relative">
            <Search className="absolute left-3 top-3 w-5 h-5 text-slate-400" />
            <input
              type="text"
              placeholder="Search cases..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-10 pr-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
            />
          </div>
        </div>

        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
        >
          <option value="">All Status</option>
          <option value="open">Open</option>
          <option value="closed">Closed</option>
          <option value="pending">Pending</option>
          <option value="archived">Archived</option>
        </select>
      </div>

      {/* Error */}
      {error && (
        <div className="p-4 bg-red-50 border border-red-200 rounded-lg flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-red-600 mt-0.5 flex-shrink-0" />
          <p className="text-red-800 text-sm">{error}</p>
        </div>
      )}

      {/* Cases Table */}
      <div className="bg-white rounded-lg shadow overflow-hidden">
        {isLoading ? (
          <div className="p-8 text-center text-slate-500">
            <div className="inline-block animate-spin">⚙️</div>
            <p className="mt-2">Loading cases...</p>
          </div>
        ) : cases.length === 0 ? (
          <div className="p-8 text-center">
            <FileText className="w-12 h-12 text-slate-300 mx-auto mb-4" />
            <p className="text-slate-500">No cases found</p>
            <button
              onClick={() => navigate('/cases/new')}
              className="mt-4 text-blue-600 hover:text-blue-700 font-medium"
            >
              Create your first case
            </button>
          </div>
        ) : (
          <table className="w-full">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr>
                <th className="px-6 py-3 text-left text-sm font-semibold text-slate-900">
                  Protocol #
                </th>
                <th className="px-6 py-3 text-left text-sm font-semibold text-slate-900">
                  Client
                </th>
                <th className="px-6 py-3 text-left text-sm font-semibold text-slate-900">
                  Status
                </th>
                <th className="px-6 py-3 text-left text-sm font-semibold text-slate-900">
                  Start Date
                </th>
                <th className="px-6 py-3 text-left text-sm font-semibold text-slate-900">
                  Action
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {cases.map((caseItem) => (
                <tr key={caseItem.id} className="hover:bg-slate-50 transition">
                  <td className="px-6 py-4 font-medium text-blue-600 hover:text-blue-700 cursor-pointer">
                    {caseItem.protocol_number}
                  </td>
                  <td className="px-6 py-4 text-slate-900">{caseItem.client_name}</td>
                  <td className="px-6 py-4">
                    <span
                      className={`px-3 py-1 rounded-full text-sm font-medium ${
                        statusColors[caseItem.status as keyof typeof statusColors] ||
                        'bg-gray-100 text-gray-800'
                      }`}
                    >
                      {caseItem.status}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-slate-600 text-sm">
                    {new Date(caseItem.starting_date).toLocaleDateString()}
                  </td>
                  <td className="px-6 py-4">
                    <button
                      onClick={() => navigate(`/cases/${caseItem.id}`)}
                      className="text-blue-600 hover:text-blue-700 text-sm font-medium"
                    >
                      View
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
