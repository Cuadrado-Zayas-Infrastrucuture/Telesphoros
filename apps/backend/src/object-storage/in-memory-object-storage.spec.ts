import { describeStorageContract } from '../../test/helpers/storage-contract';
import { InMemoryObjectStorage } from './in-memory-object-storage';

describeStorageContract('InMemoryObjectStorage', () => {
  const versioned = new InMemoryObjectStorage();
  const unversioned = new InMemoryObjectStorage();
  unversioned.versioned = false;
  return {
    versioned,
    unversioned,
    upload: async (storage, key, bytes) => (storage as InMemoryObjectStorage).put(key, bytes, 'application/pdf'),
    deleteVersion: async (storage, key, version) => (storage as InMemoryObjectStorage).deleteVersion(key, version),
  };
});
