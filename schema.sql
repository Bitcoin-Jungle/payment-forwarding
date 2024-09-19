#sqlite3 webhooks.db

CREATE TABLE stores (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	storeId TEXT,
	rate TEXT,
	bitcoinJungleUsername TEXT
);

CREATE TABLE invoices (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	storeId TEXT, 
	invoiceId TEXT, 
	isProcessing BOOLEAN DEFAULT FALSE, 
	isProcessed BOOLEAN DEFAULT FALSE
);

CREATE TABLE payments (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	paymentId TEXT,
	storeId TEXT,
	invoiceId TEXT,
	timestamp INT,
	feeRetained TEXT
);

ALTER TABLE stores ADD appId TEXT DEFAULT NULL;

CREATE TABLE tips (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	store_id INTEGER NOT NULL,
	bitcoinJungleUsername TEXT NOT NULL
);

CREATE TABLE tip_payments (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	paymentId TEXT,
	storeId TEXT,
	invoiceId TEXT,
	timestamp INT,
	bitcoinJungleUsername TEXT,
	milliSatAmount TEXT
);

ALTER TABLE stores ADD bullBitcoin TEXT DEFAULT NULL;