-- Thesis Web App - PostgreSQL Schema
-- Multi-tenant case management system for law firms

-- Organizations (Law Firms/Tenants)
CREATE TABLE organizations (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL UNIQUE,
  slug VARCHAR(100) NOT NULL UNIQUE,
  email VARCHAR(255) NOT NULL,
  phone VARCHAR(20),
  address TEXT,
  city VARCHAR(100),
  postal_code VARCHAR(10),
  country VARCHAR(100),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  is_active BOOLEAN DEFAULT TRUE,
  plan VARCHAR(50) DEFAULT 'basic' -- basic, professional, enterprise
);

-- Users
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email VARCHAR(255) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  first_name VARCHAR(100) NOT NULL,
  last_name VARCHAR(100) NOT NULL,
  role VARCHAR(50) NOT NULL, -- admin, lawyer, secretary
  avatar_url VARCHAR(255),
  phone VARCHAR(20),
  is_active BOOLEAN DEFAULT TRUE,
  last_login TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(organization_id, email)
);

-- Physical Persons (Φυσικά Πρόσωπα)
CREATE TABLE fysika_prosopa (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  eponymo VARCHAR(100) NOT NULL,
  onoma VARCHAR(100) NOT NULL,
  fatherName VARCHAR(100),
  afm VARCHAR(20), -- Tax ID
  amd VARCHAR(20), -- Professional ID
  birthDate DATE,
  nationality VARCHAR(100),
  maritalStatus VARCHAR(50),
  profession VARCHAR(100),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Legal Persons (Νομικά Πρόσωπα)
CREATE TABLE nomika_prosopa (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  eponymia VARCHAR(255) NOT NULL,
  afm VARCHAR(20),
  doy VARCHAR(100),
  legal_form VARCHAR(100),
  capital DECIMAL(15,2),
  founded_date DATE,
  headquarters TEXT,
  city VARCHAR(100),
  postal_code VARCHAR(10),
  country VARCHAR(100),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Related Persons (Σχετικά Πρόσωπα - witnesses, mediators, etc)
CREATE TABLE sxetika_prosopa (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  eponymo VARCHAR(100) NOT NULL,
  onoma VARCHAR(100) NOT NULL,
  eidos_sxesis_id INTEGER,
  afm VARCHAR(20),
  birthDate DATE,
  nationality VARCHAR(100),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Relationship Types (Είδος Σχέσης)
CREATE TABLE eidos_sxesis (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name VARCHAR(150) NOT NULL,
  description TEXT,
  UNIQUE(organization_id, name)
);

-- Opposing Lawyers (Αντίδικοι)
CREATE TABLE dikigoroi_antidikon (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  eponymo VARCHAR(100) NOT NULL,
  onoma VARCHAR(100),
  afm VARCHAR(20),
  phone VARCHAR(20),
  email VARCHAR(100),
  address TEXT,
  bar_id VARCHAR(50),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Law Office Lawyers (Δικηγόροι Γραφείου)
CREATE TABLE dikigoroi_grafeiou (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  eponymo VARCHAR(100) NOT NULL,
  onoma VARCHAR(100),
  afm VARCHAR(20),
  bar_id VARCHAR(50),
  specialization VARCHAR(150),
  energos BOOLEAN DEFAULT TRUE,
  phone VARCHAR(20),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Xeiristeies (Cases Handled By Lawyer)
CREATE TABLE xeiristes_dikigoroi (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  lawyer_id INTEGER NOT NULL REFERENCES dikigoroi_grafeiou(id) ON DELETE CASCADE,
  case_id INTEGER,
  start_date DATE,
  end_date DATE,
  status VARCHAR(50)
);

-- Address Types
CREATE TABLE address_type (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  UNIQUE(organization_id, name)
);

-- Addresses
CREATE TABLE addresses (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  prosopo_id INTEGER, -- Can be fysika_prosopa, nomika_prosopa, or other
  prosopo_type VARCHAR(50), -- 'fysika', 'nomika', 'sxetika'
  address_text TEXT NOT NULL,
  city VARCHAR(100),
  postal_code VARCHAR(10),
  country VARCHAR(100),
  address_type_id INTEGER REFERENCES address_type(id),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Phone Types
CREATE TABLE phone_types (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  UNIQUE(organization_id, name)
);

-- Phone Numbers
CREATE TABLE phone_numbers (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  prosopo_id INTEGER,
  prosopo_type VARCHAR(50),
  phone_number VARCHAR(20) NOT NULL,
  phone_type_id INTEGER REFERENCES phone_types(id),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Case Case Type Names (Ονοματολογία Υποθέσεων)
CREATE TABLE ypotheseis_onomasies (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name VARCHAR(150) NOT NULL,
  description TEXT,
  UNIQUE(organization_id, name)
);

-- Positions/Roles (Θέσεις - συμμετοχή στην υπόθεση)
CREATE TABLE thesi (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name VARCHAR(150) NOT NULL,
  UNIQUE(organization_id, name)
);

-- Cases (Υποθέσεις)
CREATE TABLE ypotheseis (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  xeirokinito_id VARCHAR(50) NOT NULL, -- Protocol number
  onomasia_id INTEGER REFERENCES ypotheseis_onomasies(id),
  perilipsi TEXT,
  diadikos_id INTEGER REFERENCES dikigoroi_antidikon(id),
  fysiko_prosopo_id INTEGER REFERENCES fysika_prosopa(id),
  nomiko_prosopo_id INTEGER REFERENCES nomika_prosopa(id),
  starting_date DATE,
  ending_date DATE,
  status VARCHAR(50), -- open, closed, pending, etc.
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(organization_id, xeirokinito_id)
);

-- Related Cases (Σχετικές Υποθέσεις)
CREATE TABLE sxetikes_ypotheseis (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  ypothesi_id INTEGER NOT NULL REFERENCES ypotheseis(id) ON DELETE CASCADE,
  sxetiki_ypothesi_id INTEGER NOT NULL REFERENCES ypotheseis(id) ON DELETE CASCADE,
  relation_type VARCHAR(100),
  UNIQUE(organization_id, ypothesi_id, sxetiki_ypothesi_id)
);

-- Courts (Δικαστήρια)
CREATE TABLE dikastiria (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name VARCHAR(150) NOT NULL,
  city VARCHAR(100),
  phone VARCHAR(20),
  address TEXT,
  court_type VARCHAR(100),
  UNIQUE(organization_id, name)
);

-- Court Divisions (Τμήματα Δικαστηρίων)
CREATE TABLE dikastiria_tmimata (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  dikastirio_id INTEGER NOT NULL REFERENCES dikastiria(id) ON DELETE CASCADE,
  name VARCHAR(150) NOT NULL,
  UNIQUE(organization_id, dikastirio_id, name)
);

-- Court Judges (Δικαστές Δικαστηρίου)
CREATE TABLE dikastiria_dikastes (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  eponymo VARCHAR(100) NOT NULL,
  onoma VARCHAR(100),
  dikastirio_id INTEGER REFERENCES dikastiria(id),
  specialization VARCHAR(150),
  phone VARCHAR(20),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Court Secretaries (Γραμματείς Δικαστηρίων)
CREATE TABLE dikastiria_grammateis (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  eponymo VARCHAR(100) NOT NULL,
  onoma VARCHAR(100),
  dikastirio_id INTEGER REFERENCES dikastiria(id),
  phone VARCHAR(20),
  email VARCHAR(100),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Lawsuit Types (Είδος Δίκης)
CREATE TABLE diadikasies (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name VARCHAR(150) NOT NULL,
  UNIQUE(organization_id, name)
);

-- Lawsuit Progress Status (Εξέλιξη Δικαστικής Ενέργειας)
CREATE TABLE dikastiria_exelixi_energeias (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name VARCHAR(150) NOT NULL,
  UNIQUE(organization_id, name)
);

-- Court Actions (Δικαστικές Ενέργειες)
CREATE TABLE dikastiria_energeies (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  ypothesi_id INTEGER NOT NULL REFERENCES ypotheseis(id) ON DELETE CASCADE,
  dikastirio_id INTEGER REFERENCES dikastiria(id),
  diadikasia_id INTEGER REFERENCES diadikasies(id),
  energeia_date DATE,
  next_hearing_date DATE,
  exelixi_id INTEGER REFERENCES dikastiria_exelixi_energeias(id),
  notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Court Action Lawyers
CREATE TABLE dikastiria_dikigoroi (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  dikastiki_energeia_id INTEGER NOT NULL REFERENCES dikastiria_energeies(id) ON DELETE CASCADE,
  lawyer_id INTEGER NOT NULL REFERENCES dikigoroi_grafeiou(id) ON DELETE CASCADE
);

-- Other Activities (Λοιπές Ενέργειες)
CREATE TABLE energeies (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  ypothesi_id INTEGER NOT NULL REFERENCES ypotheseis(id) ON DELETE CASCADE,
  energeia_type VARCHAR(100),
  energeia_date DATE,
  next_date DATE,
  description TEXT,
  status VARCHAR(50),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Other Activity Lawyers
CREATE TABLE energeies_loipes_dikigoroi (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  loiph_energeia_id INTEGER NOT NULL REFERENCES energeies(id) ON DELETE CASCADE,
  lawyer_id INTEGER NOT NULL REFERENCES dikigoroi_grafeiou(id) ON DELETE CASCADE
);

-- Filing Locations/Archives (Θέσεις Αρχειοθέτησης)
CREATE TABLE theseis_arxeiothetisis (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name VARCHAR(150) NOT NULL,
  address TEXT,
  UNIQUE(organization_id, name)
);

-- Fees/Costs Definition (Αμοιβές - Προκαθορισμένες)
CREATE TABLE amoives (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name VARCHAR(150) NOT NULL,
  value DECIMAL(10,2) NOT NULL,
  description TEXT,
  UNIQUE(organization_id, name)
);

-- Fixed Costs (Πάγια Έξοδα)
CREATE TABLE pagia_exoda (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name VARCHAR(150) NOT NULL,
  UNIQUE(organization_id, name)
);

-- Finance Cases (Χρηματικές Υποθέσεις)
CREATE TABLE finance_case (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  ypothesi_id INTEGER NOT NULL REFERENCES ypotheseis(id) ON DELETE CASCADE,
  metrimenes_ores DECIMAL(10,2),
  notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Finance - External Collaborators Fees
CREATE TABLE finance_exoda_exoterikon_synergaton (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  finance_case_id INTEGER NOT NULL REFERENCES finance_case(id) ON DELETE CASCADE,
  external_collaborator VARCHAR(200),
  amount DECIMAL(10,2),
  description TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Finance - Fixed Costs
CREATE TABLE finance_pagia_exoda (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  finance_case_id INTEGER NOT NULL REFERENCES finance_case(id) ON DELETE CASCADE,
  pagio_exodo_id INTEGER REFERENCES pagia_exoda(id),
  amount DECIMAL(10,2),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Finance - Lawyer Fees
CREATE TABLE finance_pososta_dikigoron (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  finance_case_id INTEGER NOT NULL REFERENCES finance_case(id) ON DELETE CASCADE,
  lawyer_id INTEGER REFERENCES dikigoroi_grafeiou(id),
  amount DECIMAL(10,2),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Company Information (Στοιχεία Επιχείρησης)
CREATE TABLE stoixeia_epixeirisis (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key VARCHAR(100) NOT NULL,
  value TEXT,
  UNIQUE(organization_id, key)
);

-- Case Documents (Έγγραφα Υποθέσεων)
CREATE TABLE case_documents (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  case_id INTEGER NOT NULL REFERENCES ypotheseis(id) ON DELETE CASCADE,
  file_name VARCHAR(255) NOT NULL,
  file_path VARCHAR(500), -- S3/R2 path
  file_type VARCHAR(50),
  file_size INTEGER,
  document_type VARCHAR(100), -- contract, court_order, evidence, etc
  uploaded_by INTEGER REFERENCES users(id),
  uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Countries (Reference)
CREATE TABLE countries (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL UNIQUE,
  code VARCHAR(2),
  code3 VARCHAR(3)
);

-- Cities (Reference)
CREATE TABLE cities (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  country_id INTEGER REFERENCES countries(id),
  postal_code VARCHAR(10),
  UNIQUE(country_id, name)
);

-- Indexes for performance
CREATE INDEX idx_users_organization ON users(organization_id);
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_ypotheseis_organization ON ypotheseis(organization_id);
CREATE INDEX idx_ypotheseis_xeirokinito ON ypotheseis(xeirokinito_id);
CREATE INDEX idx_ypotheseis_status ON ypotheseis(status);
CREATE INDEX idx_dikastiria_energeies_ypothesi ON dikastiria_energeies(ypothesi_id);
CREATE INDEX idx_energeies_ypothesi ON energeies(ypothesi_id);
CREATE INDEX idx_case_documents_case ON case_documents(case_id);
CREATE INDEX idx_fysika_prosopa_organization ON fysika_prosopa(organization_id);
CREATE INDEX idx_nomika_prosopa_organization ON nomika_prosopa(organization_id);
CREATE INDEX idx_dikigoroi_grafeiou_organization ON dikigoroi_grafeiou(organization_id);
