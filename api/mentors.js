// Router for mentor-matching / resume endpoints. Consolidated to stay under
// Vercel Hobby's 12-Serverless-Function limit. Underlying handlers live
// unchanged in api/_lib/mentors/*. External URLs preserved via vercel.json
// rewrites:
//
//   /api/match-mentors -> /api/mentors?action=match
//   /api/parse-resume  -> /api/mentors?action=parse-resume
//
// Handlers are required LAZILY (only the matched action loads), so each
// handler keeps the same isolation it had as a standalone function.

const handlers = {
  'match': './_lib/mentors/match.js',
  'parse-resume': './_lib/mentors/parse-resume.js',
};

module.exports = async (req, res) => {
  const action = req.query.action;
  const modPath = handlers[action];
  if (!modPath) {
    res.status(404).json({ error: `Unknown mentors action: ${action || '(none)'}` });
    return;
  }
  let handler;
  try {
    handler = require(modPath);
  } catch (err) {
    console.error(`mentors router: failed to load "${action}":`, err);
    res.status(500).json({ error: 'Mentors handler failed to load' });
    return;
  }
  return handler(req, res);
};
