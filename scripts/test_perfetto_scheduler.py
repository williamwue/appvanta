import importlib.util
from pathlib import Path
import sqlite3
import unittest

spec = importlib.util.spec_from_file_location('analyzer', Path(__file__).with_name('analyze-perfetto.py'))
analyzer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(analyzer)


class RunnableEvidenceTests(unittest.TestCase):
    def evaluate(self, rows):
        with sqlite3.connect(':memory:') as db:
            db.row_factory = sqlite3.Row
            db.executescript('CREATE TABLE thread(utid INTEGER, upid INTEGER); '
                             'INSERT INTO thread VALUES(1,10),(2,10),(3,99); '
                             'CREATE TABLE thread_state(utid INTEGER,ts INTEGER,dur INTEGER,state TEXT);')
            db.executemany('INSERT INTO thread_state VALUES(?,?,?,?)', rows)
            return dict(db.execute(analyzer.runnable_query('10', 100, 200)).fetchone())

    def test_window_clipping_threads_and_process_isolation(self):
        evidence = self.evaluate([(1, 90, 30, 'R'), (1, 180, 40, 'R+'),
                                  (2, 110, 50, 'R'), (3, 100, 100, 'R'),
                                  (1, 120, 40, 'Running'), (2, 160, 20, 'S'),
                                  (1, 200, 10, 'R'), (1, 80, 20, 'R')])
        self.assertEqual(evidence['observed_ns'], 90)
        self.assertEqual(evidence['completed_slices'], 3)
        self.assertEqual(evidence['state_rows'], 5)

    def test_unfinished_wait_is_not_invented_to_end_of_trace(self):
        evidence = self.evaluate([(1, 150, -1, 'R'), (2, 130, -1, 'R+'),
                                  (1, 200, -1, 'R'), (2, 110, 10, 'R')])
        self.assertEqual(evidence['observed_ns'], 10)
        self.assertEqual(evidence['incomplete_slices'], 2)

    def test_missing_states_are_distinct_from_observed_zero_wait(self):
        self.assertEqual(self.evaluate([])['state_rows'], 0)
        evidence = self.evaluate([(1, 100, 100, 'Running')])
        self.assertEqual(evidence['state_rows'], 1)
        self.assertEqual(evidence['observed_ns'], 0)


if __name__ == '__main__':
    unittest.main()
