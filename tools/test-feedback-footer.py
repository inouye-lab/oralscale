#!/usr/bin/env python3
"""INV-USE-7: an assignment's `feedbackFooter` closes every question's feedback.

Reuses the synthetic submission from test-debug-identity.py (no accounts,
models or real records) and runs the real autograder end to end.
"""
import importlib.util,json,pathlib,unittest
spec=importlib.util.spec_from_file_location('dbg',pathlib.Path(__file__).with_name('test-debug-identity.py'))
dbg=importlib.util.module_from_spec(spec);spec.loader.exec_module(dbg)
FOOTER='HOW THIS QUESTION IS MARKED\nA synthetic footer for the test.'
class FeedbackFooterTests(dbg.DebugIdentityTests):
    def graded(self,footer=None,where='assignment'):
        if footer is not None:
            (self.course['assignments']['quiz-03'] if where=='assignment' else self.course['defaults'])['feedbackFooter']=footer
        r=self.run_case(False,self.email)
        self.assertGreater(r['score'],0)
        return r,[t for t in r['tests'] if t['visibility']=='visible' and t['name'].startswith(('Question ','Feedback on'))]
    def test_footer_closes_every_question(self):
        r,qs=self.graded(FOOTER);self.assertTrue(qs)
        for t in qs:
            self.assertTrue(t['output'].rstrip().endswith('A synthetic footer for the test.'),t['output'])
            self.assertLess(t['output'].index('FEEDBACK'),t['output'].index('HOW THIS QUESTION IS MARKED'))
    def test_course_default_applies(self):
        r,qs=self.graded(FOOTER,where='defaults')
        self.assertTrue(all('HOW THIS QUESTION IS MARKED' in t['output'] for t in qs))
    def test_absent_or_invalid_footer_adds_nothing(self):
        base,qs0=self.graded()
        for bad in ['   ',42,['x']]:
            self.tearDown();self.setUp();r,qs=self.graded(bad)
            self.assertEqual([t['output'] for t in qs],[t['output'] for t in qs0])
    def test_footer_never_changes_the_mark(self):
        base,_=self.graded();self.tearDown();self.setUp();r,_=self.graded(FOOTER)
        self.assertEqual(r['score'],base['score'])
# Run only the footer tests, not the inherited identity suite a second time.
def load_tests(loader,tests,pattern):
    return unittest.TestSuite(FeedbackFooterTests(n) for n in loader.getTestCaseNames(FeedbackFooterTests) if 'footer' in n or 'course_default' in n)
if __name__=='__main__':unittest.main()
