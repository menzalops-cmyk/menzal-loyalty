// مصفوفة الصلاحيات لفريق منزال
const MATRIX = {
  admin: ['*'],
  manager: ['dashboard.view', 'guests.view', 'guests.contact', 'points.adjust', 'rewards.issue', 'bookings.view', 'bookings.manage',
    'units.manage', 'loyalty.manage', 'rewards.manage', 'referrals.manage', 'campaigns.manage', 'templates.manage', 'notifications.view', 'audit.view'],
  support: ['dashboard.view', 'guests.view', 'guests.contact', 'points.adjust.limited', 'bookings.view', 'bookings.manage', 'notifications.view'],
  marketing: ['dashboard.view', 'guests.view', 'campaigns.manage', 'templates.manage', 'notifications.view', 'referrals.view'],
};

export function can(role, perm) {
  const list = MATRIX[role] || [];
  if (list.includes('*') || list.includes(perm)) return true;
  // points.adjust.limited يغطي points.adjust بحد أقصى
  if (perm === 'points.adjust' && list.includes('points.adjust.limited')) return true;
  if (perm === 'referrals.view' && list.includes('referrals.manage')) return true;
  return false;
}
export const isLimitedAdjuster = (role) => !(MATRIX[role] || []).includes('*') && (MATRIX[role] || []).includes('points.adjust.limited');
