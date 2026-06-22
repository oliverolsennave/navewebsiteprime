// Router for mentor-matching / resume endpoints. Consolidated to stay under
// Vercel Hobby's 12-Serverless-Function limit. Underlying handlers live
// unchanged in api/_lib/mentors/*. External URLs preserved via vercel.json
// rewrites:
//
//   /api/match-mentors -> /api/mentors?action=match
//   /api/parse-resume  -> /api/mentors?action=parse-resume

const handlers = {
  'match': require('./_lib/mentors/match.js'),
  'parse-resume': require('./_lib/mentors/parse-resume.js'),
};

module.exports = async (req, res) => {
  const action = req.query.action;
  const handler = handlers[action];
  if (!handler) {
    res.status(404).json({ error: `Unknown mentors action: ${action || '(none)'}` });
    return;
  }
  return handler(req, res);
};
