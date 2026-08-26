# Mounted-volume verification

Kocpy includes an opt-in destructive-to-test-folder stress suite for mounted exFAT/APFS volumes and SMB/NFS shares. It creates a 256 MiB camera-like file plus 1,500 small files, copies them through the production engine, and requires every destination to pass an independent SHA-256 readback.

```bash
KOCPY_HARDWARE_DESTINATIONS='["/Volumes/EXFAT_TEST/Kocpy","/Volumes/NAS/Kocpy"]' npm run test:hardware
```

Use empty test folders only. Disconnect, space-exhaustion and mount-identity scenarios are handled by the same engine paths but should be exercised on non-production media: cancel or detach during the large file, remount, and rerun; Kocpy must validate the partial prefix and continue. A different volume UUID at the same mount path must be refused.
