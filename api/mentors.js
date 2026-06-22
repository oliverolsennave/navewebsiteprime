// Router for mentor-matching / resume endpoints. Consolidated to stay under
// Vercel Hobby's 12-Serverless-Function limit. Underlying handlers live
// unchanged in api/_lib/mentors/*. External URLs preserved via vercel.json
// rewrites:
//
//   /api/match-mentors -> /api/mentors?action=match
//   /api/parse-resume  -> /api/mentors?action=parse-resume
//
// Thunks with LITERAL require paths: the literal lets Vercel's file tracer
// bundle each file, the thunk defers execution so only the matched action
// loads (per-function isolation preserved).

const handlers = {
  'match': () => require('./_lib/mentors/match.js'),
  'parse-resume': () => require('./_lib/mentors/parse-resume.js'),
};

module.exports = async (req, res) => {
  const action = req.query.action;
  const load = handlers[action];
  if (!load) {
    res.status(404).json({ error: `Unknown mentors action: ${action || '(none)'}` });
    return;
  }
  let handler;
  try {
    handler = load();
  } catch (err) {
    console.error(`mentors router: failed to load "${action}":`, err);
    res.status(500).json({ error: 'Mentors handler failed to load' });
    return;
  }
  return handler(req, res);
};
