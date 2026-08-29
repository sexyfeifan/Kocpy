# Mounted-volume verification

Kocpy includes an opt-in destructive-to-test-folder stress suite for mounted exFAT/APFS volumes and SMB/NFS shares. It creates a 256 MiB camera-like file plus 1,500 small files, copies them through the production engine, and requires every destination to pass an independent SHA-256 readback.

```bash
KOCPY_HARDWARE_DESTINATIONS='["/Volumes/EXFAT_TEST/Kocpy","/Volumes/NAS/Kocpy"]' npm run test:hardware
```

Use empty test folders only. Disconnect, space-exhaustion and mount-identity scenarios are handled by the same engine paths but should be exercised on non-production media: cancel or detach during the large file, remount, and rerun; Kocpy must validate the partial prefix and continue. A different volume UUID at the same mount path must be refused.

## 0.1.4 mounted-volume results

On 2026-08-29 the 0.1.4 production engine passed the 256 MiB + 1,500 small-file suite on two physical external APFS volumes simultaneously. It also passed isolated writable APFS, exFAT and HFS+ disk images; every destination completed independent SHA-256 readback and all temporary test directories were removed. SMB/NAS remains an opt-in test because no disposable authenticated share was available on the build host.

## Historical 0.1.0 disposable-volume result

On 2026-08-29 the production backup engine completed the suite against two simultaneously mounted 640 MiB disposable disk images: one APFS and one exFAT. It copied a 256 MiB large file plus 1,500 small files to both volumes and independently read every destination back with SHA-256. Both destinations passed; duration was 91.26 seconds. These were real mounted file systems, but not physical readers, cables, disks, SMB, or NFS.

## Fault exercise matrix

Run every exercise with generated data and disposable destinations only:

| Scenario | Expected result |
| --- | --- |
| Remove destination during copy | Healthy destinations continue; removed destination becomes available for targeted retry |
| Remove destination during verification | Copied files remain; the destination is marked unverified and can be reverified |
| Reconnect the same volume | UUID matches and the valid partial prefix is reused |
| Mount a different volume at the same path | Identity validation refuses to continue |
| Exhaust destination capacity | That destination fails without overwriting an existing final file |
| Interrupt the application | The next launch classifies the task as interrupted and offers recovery |
| Introduce NAS latency or a short outage | Local destinations continue and the network target remains retryable |

After each run, export a diagnostic package and confirm it contains the failure classification and event timeline but no full private path or media filename list.
