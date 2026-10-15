-- Only for a disposable local rangebuddy_test database. Production tables already exist.
CREATE TABLE "Vans" (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    license_plate VARCHAR(20) NOT NULL UNIQUE,
    activation_date DATE NOT NULL,
    initial_kms INTEGER NOT NULL CHECK (initial_kms >= 0),
    last_kms INTEGER NOT NULL,
    token_hash VARCHAR(64) UNIQUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT vans_last_kms_check CHECK (last_kms >= initial_kms)
);
CREATE TABLE "FuelEntries" (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    van_id INTEGER NOT NULL,
    current_kms INTEGER NOT NULL CHECK (current_kms >= 0),
    litres NUMERIC(10,3) NOT NULL CHECK (litres > 0),
    price_per_litre NUMERIC(8,3) NOT NULL CHECK (price_per_litre > 0),
    fuel_date TIMESTAMPTZ NOT NULL,
    CONSTRAINT fk_van FOREIGN KEY (van_id) REFERENCES "Vans"(id) ON DELETE RESTRICT
);
CREATE INDEX idx_fuel_entries_van_date ON "FuelEntries" (van_id, fuel_date);
CREATE INDEX idx_fuel_entries_date ON "FuelEntries" (fuel_date);
