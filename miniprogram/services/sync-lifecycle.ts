import type { DataService } from "./data-service";
interface SyncHooks {
  cancelMedication(id: string): Promise<void>;
  clear(): void;
}
const hooks = new WeakMap<DataService, SyncHooks>();
export const registerSyncHooks = (
  service: DataService,
  callbacks: SyncHooks,
): void => {
  hooks.set(service, callbacks);
};
export const cancelMedicationSync = async (
  service: DataService,
  id: string,
): Promise<void> => {
  await hooks.get(service)?.cancelMedication(id);
};
export const clearAccountSync = (service: DataService): void => {
  hooks.get(service)?.clear();
};
