"""Session setup is test-database-only; never migrate a production DSN."""
import os
from pathlib import Path

import pytest
from bidforge_live.repository import Repository


@pytest.fixture(scope='session',autouse=True)
def prepared_postgres_test_database():
    dsn=os.environ.get('DATABASE_URL','postgresql:///bidforge_live_test')
    if not dsn.startswith(('postgresql://','postgres://')):
        raise RuntimeError('An isolated PostgreSQL test database is required')
    repo=Repository(dsn)
    with repo.tx()as conn:
        name=conn.execute('SELECT current_database() AS name').fetchone()['name']
    if name!='bidforge_live_test':
        raise RuntimeError('Refusing to migrate a database not named bidforge_live_test')
    repo.migrate(Path(__file__).resolve().parents[1]/'schema.sql')
    return repo
