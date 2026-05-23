import dbQuery from "../db.js";

export const createTrainingVideosTable = async () => {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS training_videos (
      id               SERIAL PRIMARY KEY,
      module_id        INTEGER NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
      title            VARCHAR(200) NOT NULL,
      description      TEXT,
      video_url        TEXT NOT NULL,
      permission_type  VARCHAR(20) NOT NULL CHECK (permission_type IN ('view', 'add', 'edit', 'delete', 'authorize')),
      is_active        BOOLEAN DEFAULT true,
      approved         BOOLEAN DEFAULT false,
      approved_by      INTEGER REFERENCES users(id),
      approved_at      TIMESTAMP,
      is_deleted       BOOLEAN DEFAULT false,
      deleted_by       INTEGER REFERENCES users(id),
      deleted_at       TIMESTAMP,
      created_by       INTEGER REFERENCES users(id),
      created_at       TIMESTAMP DEFAULT NOW(),
      updated_by       INTEGER REFERENCES users(id),
      updated_at       TIMESTAMP
    );
  `);
};