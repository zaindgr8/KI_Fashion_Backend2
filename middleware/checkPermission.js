const checkPermission = (requiredPermission) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Unauthorized'
      });
    }

    // super-admin has ALL permissions
    if (req.user.role === 'super-admin') {
      return next();
    }

    // Check if user has the specific permission
    const hasPermission = req.user.permissions && req.user.permissions.includes(requiredPermission);

    if (!hasPermission) {
      return res.status(403).json({
        success: false,
        message: `Permission denied: ${requiredPermission} access required`
      });
    }

    next();
  };
};

module.exports = checkPermission;
