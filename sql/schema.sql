-- =====================================================================
-- Thesis Web v3 — Full PostgreSQL schema
-- Multi-tenant: every domain table carries organization_id
-- Reverse-engineered 1:1 from VB.NET Thesis desktop app source
-- =====================================================================

-- =============== 0. Organizations & Users =============================

CREATE TABLE IF NOT EXISTS organizations (
  id             SERIAL PRIMARY KEY,
  name           VARCHAR(200) NOT NULL,
  slug           VARCHAR(80)  UNIQUE,
  created_at     TIMESTAMPTZ  DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  id              SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email           VARCHAR(200) NOT NULL,
  password_hash   VARCHAR(255) NOT NULL,
  first_name      VARCHAR(100),
  last_name       VARCHAR(100),
  role            VARCHAR(30) DEFAULT 'lawyer',       -- admin | lawyer | secretary
  is_active       BOOLEAN DEFAULT TRUE,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(organization_id, email)
);
CREATE INDEX IF NOT EXISTS idx_users_org      ON users(organization_id);
CREATE INDEX IF NOT EXISTS idx_users_email    ON users(email);

-- =============== 1. Lookup tables (per-tenant seeded) =================

CREATE TABLE IF NOT EXISTS countries (
  aa              SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            VARCHAR(150) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_countries_org ON countries(organization_id);

CREATE TABLE IF NOT EXISTS cities (
  aa              SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            VARCHAR(150) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cities_org ON cities(organization_id);

CREATE TABLE IF NOT EXISTS address_type (
  aa              SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  address_type    VARCHAR(80)  NOT NULL
);

CREATE TABLE IF NOT EXISTS phone_types (
  aa              SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  phone_type      VARCHAR(80)  NOT NULL
);

CREATE TABLE IF NOT EXISTS diadikasies (
  aa              SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            VARCHAR(200) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_diadikasies_org ON diadikasies(organization_id);

CREATE TABLE IF NOT EXISTS thesi (
  aa              SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            VARCHAR(150) NOT NULL
);

CREATE TABLE IF NOT EXISTS ypotheseis_onomasies (
  aa              SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            VARCHAR(200) NOT NULL
);

CREATE TABLE IF NOT EXISTS theseis_arxeiothetisis (
  aa              SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            VARCHAR(200) NOT NULL,
  perigrafi       TEXT
);

CREATE TABLE IF NOT EXISTS eidos_sxesis (
  aa              SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            VARCHAR(150) NOT NULL
);

CREATE TABLE IF NOT EXISTS pagia_exoda (
  aa              SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            VARCHAR(200) NOT NULL
);

CREATE TABLE IF NOT EXISTS amoives (
  aa              SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            VARCHAR(200) NOT NULL,
  amount          NUMERIC(12,2) DEFAULT 0
);

-- =============== 2. Courts (dikastiria) ================================

CREATE TABLE IF NOT EXISTS dikastiria (
  aa              SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            VARCHAR(300) NOT NULL,
  vathmos         VARCHAR(100),                       -- Ανώτατο, Εφετείο, Πρωτοδικείο, Ειρηνοδικείο, ...
  eidos           VARCHAR(100),                       -- Πολιτικό, Ποινικό, Διοικητικό, Στρατιωτικό, ...
  edra            VARCHAR(150)                        -- Αθηνών, Θεσσαλονίκης, ...
);
CREATE INDEX IF NOT EXISTS idx_dikastiria_org ON dikastiria(organization_id);

CREATE TABLE IF NOT EXISTS dikastiria_tmimata (
  aa              SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            VARCHAR(200) NOT NULL
);

CREATE TABLE IF NOT EXISTS dikastiria_dikastes (
  aa              SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  eponymo         VARCHAR(150),
  onoma           VARCHAR(150)
);

CREATE TABLE IF NOT EXISTS dikastiria_grammateis (
  aa              SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  eponymo         VARCHAR(150),
  onoma           VARCHAR(150)
);

CREATE TABLE IF NOT EXISTS dikastiria_exelixi_energeias (
  aa              SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            VARCHAR(200) NOT NULL
);

-- =============== 3. Persons (physical, legal, related) =================

-- Φυσικά πρόσωπα (clients + related)
CREATE TABLE IF NOT EXISTS fysika_prosopa (
  aa                    SERIAL PRIMARY KEY,
  organization_id       INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  eponymo               VARCHAR(150) NOT NULL,
  onoma                 VARCHAR(150),
  onoma_patros          VARCHAR(150),
  eponymo_syzygou       VARCHAR(150),
  onoma_syzygou         VARCHAR(150),
  date_gennisis         DATE,
  afm                   VARCHAR(30),
  doy                   VARCHAR(150),
  adt                   VARCHAR(30),
  ekdousa_arxi          VARCHAR(200),
  email                 VARCHAR(200),
  web_site              VARCHAR(300),
  energos               BOOLEAN DEFAULT TRUE,
  odos_oikias           VARCHAR(200),
  arithmos_oikias       VARCHAR(30),
  tk_oikias             VARCHAR(20),
  poli_oikias           VARCHAR(150),
  xora_oikias           VARCHAR(150),
  odos_grafeiou         VARCHAR(200),
  arithmos_grafeiou     VARCHAR(30),
  tk_grafeiou           VARCHAR(20),
  poli_grafeiou         VARCHAR(150),
  xora_grafeiou         VARCHAR(150),
  tilefono_oikias_1     VARCHAR(50),
  tilefono_oikias_2     VARCHAR(50),
  tilefono_oikias_3     VARCHAR(50),
  tilefono_grafeiou_1   VARCHAR(50),
  tilefono_grafeiou_2   VARCHAR(50),
  tilefono_grafeiou_3   VARCHAR(50),
  tilefono_kinito_1     VARCHAR(50),
  tilefono_kinito_2     VARCHAR(50),
  tilefono_kinito_3     VARCHAR(50),
  fax_1                 VARCHAR(50),
  fax_2                 VARCHAR(50),
  fax_3                 VARCHAR(50),
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_fysika_org      ON fysika_prosopa(organization_id);
CREATE INDEX IF NOT EXISTS idx_fysika_eponymo  ON fysika_prosopa(organization_id, eponymo);

-- Νομικά πρόσωπα (clients)
CREATE TABLE IF NOT EXISTS nomika_prosopa (
  aa                    SERIAL PRIMARY KEY,
  organization_id       INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  diakritikos_titlos    VARCHAR(200),
  eponymia              VARCHAR(300) NOT NULL,
  afm                   VARCHAR(30),
  doy                   VARCHAR(150),
  email                 VARCHAR(200),
  web_site              VARCHAR(300),
  energos               BOOLEAN DEFAULT TRUE,
  odos                  VARCHAR(200),
  arithmos              VARCHAR(30),
  tk                    VARCHAR(20),
  poli                  VARCHAR(150),
  xora                  VARCHAR(150),
  tilefono_grafeiou_1   VARCHAR(50),
  tilefono_grafeiou_2   VARCHAR(50),
  tilefono_grafeiou_3   VARCHAR(50),
  tilefono_kinito_1     VARCHAR(50),
  tilefono_kinito_2     VARCHAR(50),
  tilefono_kinito_3     VARCHAR(50),
  fax_1                 VARCHAR(50),
  fax_2                 VARCHAR(50),
  fax_3                 VARCHAR(50),
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_nomika_org       ON nomika_prosopa(organization_id);
CREATE INDEX IF NOT EXISTS idx_nomika_eponymia  ON nomika_prosopa(organization_id, eponymia);

-- Σχετικά πρόσωπα (loipa relatives / related persons)
CREATE TABLE IF NOT EXISTS sxetika_prosopa (
  aa                    SERIAL PRIMARY KEY,
  organization_id       INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  eponymia              VARCHAR(300),
  diakritikos_titlos    VARCHAR(200),
  eponymo               VARCHAR(150),
  onoma                 VARCHAR(150),
  onoma_patros          VARCHAR(150),
  eponymo_syzygou       VARCHAR(150),
  onoma_syzygou         VARCHAR(150),
  date_gennisis         DATE,
  afm                   VARCHAR(30),
  doy                   VARCHAR(150),
  adt                   VARCHAR(30),
  ekdousa_arxi          VARCHAR(200),
  email                 VARCHAR(200),
  web_site              VARCHAR(300),
  energos               BOOLEAN DEFAULT TRUE,
  odos_oikias           VARCHAR(200),
  arithmos_oikias       VARCHAR(30),
  tk_oikias             VARCHAR(20),
  poli_oikias           VARCHAR(150),
  xora_oikias           VARCHAR(150),
  odos_grafeiou         VARCHAR(200),
  arithmos_grafeiou     VARCHAR(30),
  tk_grafeiou           VARCHAR(20),
  poli_grafeiou         VARCHAR(150),
  xora_grafeiou         VARCHAR(150),
  tilefono_oikias_1     VARCHAR(50),
  tilefono_oikias_2     VARCHAR(50),
  tilefono_oikias_3     VARCHAR(50),
  tilefono_grafeiou_1   VARCHAR(50),
  tilefono_grafeiou_2   VARCHAR(50),
  tilefono_grafeiou_3   VARCHAR(50),
  tilefono_kinito_1     VARCHAR(50),
  tilefono_kinito_2     VARCHAR(50),
  tilefono_kinito_3     VARCHAR(50),
  fax_1                 VARCHAR(50),
  fax_2                 VARCHAR(50),
  fax_3                 VARCHAR(50),
  eidos_sxesis_id       INTEGER,
  ypotheseis_id         INTEGER,
  created_at            TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sxetika_org ON sxetika_prosopa(organization_id);

-- Δικηγόροι Γραφείου (our lawyers)
CREATE TABLE IF NOT EXISTS dikigoroi_grafeiou (
  aa                SERIAL PRIMARY KEY,
  organization_id   INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  eponymo           VARCHAR(150),
  onoma             VARCHAR(150),
  onoma_patros      VARCHAR(150),
  eponymo_syzygou   VARCHAR(150),
  onoma_syzygou     VARCHAR(150),
  date_gennisis     DATE,
  adt               VARCHAR(30),
  afm               VARCHAR(30),
  doy               VARCHAR(150),
  energos           BOOLEAN DEFAULT TRUE,
  date_eggrafis     DATE,
  date_diagrafis    DATE,
  ar_mitroou        VARCHAR(50),
  syllogos          VARCHAR(50),                      -- ΔΣΑ, ΔΣΘ, ΔΣΠ, ΔΣΗ ...
  email             VARCHAR(200),
  mobile            VARCHAR(50),
  exoterikos        BOOLEAN DEFAULT FALSE,            -- εξωτερικός συνεργάτης
  created_at        TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_dikigoroi_org ON dikigoroi_grafeiou(organization_id);

-- Δικηγόροι Αντιδίκων
CREATE TABLE IF NOT EXISTS dikigoroi_antidikon (
  aa              SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  eponymo         VARCHAR(200) NOT NULL,
  onoma           VARCHAR(150),
  email           VARCHAR(200),
  tilefono        VARCHAR(50),
  syllogos        VARCHAR(50)
);
CREATE INDEX IF NOT EXISTS idx_dikigoroi_antidikon_org ON dikigoroi_antidikon(organization_id);

-- Αντίδικοι
CREATE TABLE IF NOT EXISTS antidikoi (
  aa              SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  eponymo         VARCHAR(300) NOT NULL,
  onoma           VARCHAR(150),
  telefono        VARCHAR(50),
  email           VARCHAR(200)
);
CREATE INDEX IF NOT EXISTS idx_antidikoi_org ON antidikoi(organization_id);

-- =============== 4. Cases (ypotheseis) ================================

CREATE TABLE IF NOT EXISTS ypotheseis (
  aa                     SERIAL PRIMARY KEY,
  organization_id        INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  xeirokinito_id         VARCHAR(80),                 -- protocol number, e.g. "5Φ/3/127"
  onomasia_id            INTEGER REFERENCES ypotheseis_onomasies(aa),
  date_eisagogis         DATE,
  date_telous            DATE,
  onomasia_fakelou       VARCHAR(300),                -- ονομασία / αριθμός φακέλου
  ekkremis               BOOLEAN DEFAULT TRUE,
  perilipsi              TEXT,
  fysiko_prosopo_id      INTEGER REFERENCES fysika_prosopa(aa),
  nomiko_prosopo_id      INTEGER REFERENCES nomika_prosopa(aa),
  thesi                  INTEGER REFERENCES thesi(aa),
  diadikos_id            INTEGER REFERENCES antidikoi(aa),
  thesi_arxeiothetisis_id INTEGER REFERENCES theseis_arxeiothetisis(aa),
  arithmos_apofasis      VARCHAR(100),
  dekti                  BOOLEAN DEFAULT FALSE,
  merikos_dekti          BOOLEAN DEFAULT FALSE,
  aporriptea             BOOLEAN DEFAULT FALSE,
  old_kod                VARCHAR(100),                -- Α.Κ. / παλιός κωδικός
  prosvalomeni           VARCHAR(200),
  created_at             TIMESTAMPTZ DEFAULT NOW(),
  updated_at             TIMESTAMPTZ DEFAULT NOW(),
  CHECK (fysiko_prosopo_id IS NOT NULL OR nomiko_prosopo_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_ypotheseis_org       ON ypotheseis(organization_id);
CREATE INDEX IF NOT EXISTS idx_ypotheseis_protocol  ON ypotheseis(organization_id, xeirokinito_id);
CREATE INDEX IF NOT EXISTS idx_ypotheseis_fp        ON ypotheseis(organization_id, fysiko_prosopo_id);
CREATE INDEX IF NOT EXISTS idx_ypotheseis_np        ON ypotheseis(organization_id, nomiko_prosopo_id);
CREATE INDEX IF NOT EXISTS idx_ypotheseis_ekkremis  ON ypotheseis(organization_id, ekkremis);

-- Χειριστές δικηγόροι (case ↔ lawyer)
CREATE TABLE IF NOT EXISTS xeiristes_dikigoroi (
  aa                    SERIAL PRIMARY KEY,
  organization_id       INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  ypotheseis_id         INTEGER NOT NULL REFERENCES ypotheseis(aa) ON DELETE CASCADE,
  dikigoroi_grafeiou_id INTEGER NOT NULL REFERENCES dikigoroi_grafeiou(aa),
  UNIQUE(ypotheseis_id, dikigoroi_grafeiou_id)
);
CREATE INDEX IF NOT EXISTS idx_xeiristes_case ON xeiristes_dikigoroi(ypotheseis_id);

-- Σχετικές υποθέσεις
CREATE TABLE IF NOT EXISTS sxetikes_ypotheseis (
  aa                  SERIAL PRIMARY KEY,
  organization_id     INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  ypothesi_id         INTEGER NOT NULL REFERENCES ypotheseis(aa) ON DELETE CASCADE,
  sxetiki_ypothesi_id INTEGER NOT NULL REFERENCES ypotheseis(aa),
  UNIQUE(ypothesi_id, sxetiki_ypothesi_id)
);

-- Λοιπές ενέργειες / tasks per case
CREATE TABLE IF NOT EXISTS energeies (
  aa                 SERIAL PRIMARY KEY,
  organization_id    INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  ypotheseis_id      INTEGER NOT NULL REFERENCES ypotheseis(aa) ON DELETE CASCADE,
  perigrafi_energias TEXT,
  date_dead_line     DATE,
  ekkremis           BOOLEAN DEFAULT TRUE,
  created_at         TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_energeies_case      ON energeies(ypotheseis_id);
CREATE INDEX IF NOT EXISTS idx_energeies_deadline  ON energeies(organization_id, ekkremis, date_dead_line);

-- Δικαστικές ενέργειες (hearings)
CREATE TABLE IF NOT EXISTS dikastiria_energeies (
  aa                      SERIAL PRIMARY KEY,
  organization_id         INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  ypothesi_id             INTEGER NOT NULL REFERENCES ypotheseis(aa) ON DELETE CASCADE,
  name                    VARCHAR(300),                -- περιγραφή
  date                    DATE NOT NULL,
  dikastirio_id           INTEGER REFERENCES dikastiria(aa),
  tmima_id                INTEGER REFERENCES dikastiria_tmimata(aa),
  city_id                 INTEGER REFERENCES cities(aa),
  antidikos_id            INTEGER REFERENCES antidikoi(aa),
  diadikasia_id           INTEGER REFERENCES diadikasies(aa),
  pinakio                 VARCHAR(100),
  dikigoros_antidikou_id  INTEGER REFERENCES dikigoroi_antidikon(aa),
  dikastis_id             INTEGER REFERENCES dikastiria_dikastes(aa),
  grammateas_id           INTEGER REFERENCES dikastiria_grammateis(aa)
);
CREATE INDEX IF NOT EXISTS idx_dikergeies_case ON dikastiria_energeies(ypothesi_id);
CREATE INDEX IF NOT EXISTS idx_dikergeies_date ON dikastiria_energeies(organization_id, date);

-- Εξελίξεις δικαστικών ενεργειών
CREATE TABLE IF NOT EXISTS dikastiria_energeies_exelixeis (
  aa                     SERIAL PRIMARY KEY,
  organization_id        INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  dikastiki_energeia_id  INTEGER NOT NULL REFERENCES dikastiria_energeies(aa) ON DELETE CASCADE,
  name                   VARCHAR(300),
  date                   DATE,
  exelixi_id             INTEGER REFERENCES dikastiria_exelixi_energeias(aa),
  dikigoros_id           INTEGER REFERENCES dikigoroi_grafeiou(aa),
  dikos_mas              BOOLEAN DEFAULT TRUE,
  dateend                DATE,
  stamp                  INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_dikexelixi_energeia ON dikastiria_energeies_exelixeis(dikastiki_energeia_id);

-- Χειριστές δικηγόροι σε δικαστική ενέργεια
CREATE TABLE IF NOT EXISTS dikastiria_dikigoroi (
  aa                      SERIAL PRIMARY KEY,
  organization_id         INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  dikastiki_energeia_id   INTEGER NOT NULL REFERENCES dikastiria_energeies(aa) ON DELETE CASCADE,
  dikigoros_id            INTEGER NOT NULL REFERENCES dikigoroi_grafeiou(aa),
  UNIQUE(dikastiki_energeia_id, dikigoros_id)
);

-- =============== 5. Finance per case ==================================

CREATE TABLE IF NOT EXISTS finance_ores (
  aa              SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  ypothesi_id     INTEGER NOT NULL REFERENCES ypotheseis(aa) ON DELETE CASCADE,
  dikigoros_id    INTEGER REFERENCES dikigoroi_grafeiou(aa),
  date            DATE DEFAULT CURRENT_DATE,
  ores            NUMERIC(6,2) DEFAULT 0,
  perigrafi       TEXT,
  amount          NUMERIC(12,2) DEFAULT 0
);

CREATE TABLE IF NOT EXISTS finance_pagia_exoda_case (
  aa                       SERIAL PRIMARY KEY,
  organization_id          INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  ypothesi_id              INTEGER NOT NULL REFERENCES ypotheseis(aa) ON DELETE CASCADE,
  pagio_exodo_definition_id INTEGER REFERENCES pagia_exoda(aa),
  date                     DATE DEFAULT CURRENT_DATE,
  amount                   NUMERIC(12,2) DEFAULT 0,
  perigrafi                TEXT
);

CREATE TABLE IF NOT EXISTS finance_amoives_dikigoron (
  aa              SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  ypothesi_id     INTEGER NOT NULL REFERENCES ypotheseis(aa) ON DELETE CASCADE,
  dikigoros_id    INTEGER REFERENCES dikigoroi_grafeiou(aa),
  date            DATE DEFAULT CURRENT_DATE,
  amount          NUMERIC(12,2) DEFAULT 0,
  perigrafi       TEXT
);

CREATE TABLE IF NOT EXISTS finance_exoda_exoterikou_synergati (
  aa              SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  ypothesi_id     INTEGER NOT NULL REFERENCES ypotheseis(aa) ON DELETE CASCADE,
  synergatis_id   INTEGER REFERENCES sxetika_prosopa(aa),
  date            DATE DEFAULT CURRENT_DATE,
  amount          NUMERIC(12,2) DEFAULT 0,
  perigrafi       TEXT
);

-- =============== 6. Documents per case (Cloudflare R2) =================

CREATE TABLE IF NOT EXISTS case_documents (
  aa              SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  ypothesi_id     INTEGER NOT NULL REFERENCES ypotheseis(aa) ON DELETE CASCADE,
  filename        VARCHAR(300) NOT NULL,
  r2_key          VARCHAR(500) NOT NULL,
  mime_type       VARCHAR(150),
  size_bytes      BIGINT,
  uploaded_by     INTEGER REFERENCES users(id),
  uploaded_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_case_documents_case ON case_documents(ypothesi_id);

-- =============== 7. Organization settings (stoixeia_epixeirisis) ======

CREATE TABLE IF NOT EXISTS stoixeia_epixeirisis (
  aa              SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,
  eponymia        VARCHAR(300),
  afm             VARCHAR(30),
  doy             VARCHAR(150),
  odos            VARCHAR(200),
  arithmos        VARCHAR(30),
  tk              VARCHAR(20),
  poli            VARCHAR(150),
  xora            VARCHAR(150) DEFAULT 'Ελλάδα',
  tilefono_1      VARCHAR(50),
  tilefono_2      VARCHAR(50),
  fax             VARCHAR(50),
  email           VARCHAR(200),
  web_site        VARCHAR(300),
  logo_r2_key     VARCHAR(500)
);
