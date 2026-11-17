-- How a list guest first arrived: 'token' (personal link) or 'name' (typed their first name on the shared link).
ALTER TABLE guests ADD COLUMN joined_via TEXT;
