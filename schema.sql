#sqlite3 webhooks.db

CREATE TABLE stores (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	storeId TEXT,
	rate TEXT,
	bitcoinJungleUsername TEXT
);

CREATE TABLE executions (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	manuallyMarked BOOLEAN,
	deliveryId TEXT,
	webhookId TEXT,
	originalDeliveryId TEXT,
	isRedelivery TEXT,
	type TEXT,
	timestamp INT,
	storeId TEXT,
	invoiceId TEXT,
	isProcessed BOOLEAN DEFAULT FALSE
);

CREATE TABLE payments (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	paymentId TEXT,
	deliveryId TEXT,
	timestamp INT
);