import { connectionBudget } from './connection-limits';

// The arithmetic on values a local server does not have: reserved_connections above 0, and the RDS administrator's own slots.
describe('connectionBudget', () => {
  it('takes every reserved slot off max_connections', () => {
    expect(connectionBudget({ maxConnections: 189, superuserReserved: 3, reserved: 4, rdsReserved: 2 })).toBe(180);
  });

  it('counts a setting the server does not have as no slots', () => {
    expect(connectionBudget({ maxConnections: 100, superuserReserved: 3, reserved: null, rdsReserved: null })).toBe(97);
  });
});
