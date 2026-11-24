CREATE TABLE mailbox_users (id TEXT PRIMARY KEY NOT NULL, peer_id TEXT NOT NULL, name TEXT NOT NULL, language TEXT NOT NULL);
--> statement-breakpoint
CREATE TABLE mailbox_contacts (owner TEXT NOT NULL, sender TEXT NOT NULL, peer_id TEXT NOT NULL, PRIMARY KEY (owner,sender));
--> statement-breakpoint
CREATE TABLE mailbox_messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, sender TEXT NOT NULL, recipient TEXT NOT NULL, message_id TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(sender,recipient,message_id));
--> statement-breakpoint
CREATE INDEX mailbox_inbox ON mailbox_messages(recipient,seq);
--> statement-breakpoint
CREATE INDEX mailbox_expiry ON mailbox_messages(created_at);
