ALTER TABLE sessions ADD COLUMN assessment_prompt text;
ALTER TABLE sessions ADD COLUMN assessment_prompt_version int NOT NULL DEFAULT 0;
ALTER TABLE roles ADD COLUMN revision int NOT NULL DEFAULT 0;
