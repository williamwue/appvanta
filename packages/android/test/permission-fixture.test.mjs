import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePermissionFlags, parsePermissionGrant } from '../dist/index.js';
import * as permissions from '../dist/permission-fixture.js';

test('package permission snapshot isolates package, user and runtime section', () => {
  const dump = `Packages:
  Package [dev.appvanta.input] (abc):
    requested permissions:
      android.permission.CAMERA
    User 0: installed=true
      runtime permissions:
        android.permission.CAMERA: granted=false, flags=[ USER_SET|USER_FIXED ]
    User 10: installed=true
      runtime permissions:
        android.permission.CAMERA: granted=true, flags=[ ]
  Package [other.app] (def):
    User 0: installed=true
      runtime permissions:
        android.permission.CAMERA: granted=true, flags=[ ]
`;
  assert.deepEqual(permissions.parsePermissionSnapshot(dump, 'dev.appvanta.input', 'android.permission.CAMERA', 0), { granted: false, flags: ['user-fixed', 'user-set'] });
  assert.deepEqual(permissions.parsePermissionSnapshot(dump, 'dev.appvanta.input', 'android.permission.CAMERA', 10), { granted: true, flags: [] });
  for (const [pkg, permission, user] of [['missing.app', 'android.permission.CAMERA', 0], ['dev.appvanta.input', 'android.permission.RECORD_AUDIO', 0], ['dev.appvanta.input', 'android.permission.CAMERA', 11]]) {
    assert.throws(() => permissions.parsePermissionSnapshot(dump, pkg, permission, user));
  }
  assert.throws(() => permissions.parsePermissionSnapshot(dump.replace('granted=false', 'granted=unknown'), 'dev.appvanta.input', 'android.permission.CAMERA', 0));
  assert.throws(() => permissions.parsePermissionSnapshot(dump + dump, 'dev.appvanta.input', 'android.permission.CAMERA', 0));
});

test('runtime permission parsers reject ambiguous state and normalize flags', () => {
  assert.equal(parsePermissionGrant('granted\n'), true);
  assert.equal(parsePermissionGrant('denied\r\n'), false);
  assert.throws(() => parsePermissionGrant('unknown'));
  assert.deepEqual(parsePermissionFlags('Permission flags: [ USER_SET|USER_FIXED ]'), ['user-fixed', 'user-set']);
  assert.deepEqual(parsePermissionFlags('Permission flags: [  ]'), []);
  assert.throws(() => parsePermissionFlags('flags=USER_SET'));
  assert.throws(() => parsePermissionFlags('Permission flags: [ user-set ]'));
});
