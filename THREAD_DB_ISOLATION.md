THREAD: DB isolation
GOAL: eliminate shared DB across tests
SCOPE:
- introduce test_db_factory
- refactor tests to use isolated db
- enforce teardown close
- remove shared db dependency
