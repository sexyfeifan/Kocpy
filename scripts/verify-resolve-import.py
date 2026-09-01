#!/usr/bin/env python3
"""Import isolated Kocpy proxy fixtures into a temporary Resolve project."""

import json
import os
import sys
import time
import uuid


def fail(message: str) -> None:
    print(json.dumps({"passed": False, "error": message}, ensure_ascii=False))
    raise SystemExit(1)


def main() -> None:
    paths = [os.path.abspath(item) for item in sys.argv[1:]]
    if not paths or any(not os.path.isfile(item) for item in paths):
        fail("Provide one or more existing isolated media files")

    try:
        import DaVinciResolveScript as dvr_script
    except ImportError as error:
        fail(f"Resolve scripting module unavailable: {error}")

    resolve = None
    for _ in range(30):
        resolve = dvr_script.scriptapp("Resolve")
        if resolve:
            break
        time.sleep(1)
    if not resolve:
        fail("Resolve scripting connection unavailable")

    manager = resolve.GetProjectManager()
    owned_instance = os.environ.get("KOCPY_RESOLVE_OWNED_INSTANCE") == "1"
    if owned_instance:
        manager.GotoRootFolder()
    previous = manager.GetCurrentProject()
    previous_name = previous.GetName() if previous else None
    previous_is_transient = False
    project_name = f"Kocpy_Proxy_Import_Verification_{uuid.uuid4().hex[:10]}"
    project = manager.CreateProject(project_name)
    if (
        not project
        and owned_instance
        and previous
        and previous_name == "Untitled Project"
        and previous_name not in (manager.GetProjectListInCurrentFolder() or [])
    ):
        # A newly launched, Kocpy-owned headless Resolve instance starts with a
        # transient empty project that can prevent CreateProject. Never apply
        # this fallback to an existing/saved user project.
        previous_is_transient = bool(manager.CloseProject(previous))
        if previous_is_transient:
            previous = None
            previous_name = None
            project = manager.CreateProject(project_name)
    if not project:
        fail("Could not create isolated Resolve verification project")

    result = None
    cleanup = {"closed": False, "deleted": False, "restored": False}
    try:
        clips = resolve.GetMediaStorage().AddItemListToMediaPool(paths) or []
        imported = []
        for clip in clips:
            properties = clip.GetClipProperty() or {}
            imported.append(
                {
                    "name": clip.GetName(),
                    "filePath": properties.get("File Path"),
                    "format": properties.get("Format"),
                    "codec": properties.get("Video Codec"),
                    "resolution": properties.get("Resolution"),
                    "fps": properties.get("FPS"),
                    "duration": properties.get("Duration"),
                    "startTimecode": properties.get("Start TC"),
                    "audioChannels": properties.get("Audio Ch"),
                }
            )
        imported_paths = {
            os.path.realpath(item.get("filePath"))
            for item in imported
            if item.get("filePath")
        }
        expected_paths = {os.path.realpath(item) for item in paths}
        passed = len(imported) == len(paths) and imported_paths == expected_paths
        result = {
            "passed": passed,
            "project": project_name,
            "requested": len(paths),
            "imported": imported,
        }
    finally:
        manager.SaveProject()
        cleanup["closed"] = bool(manager.CloseProject(project))
        cleanup["deleted"] = bool(manager.DeleteProject(project_name))
        if previous_name:
            cleanup["restored"] = bool(manager.LoadProject(previous_name))
        else:
            cleanup["restored"] = True

    result["cleanup"] = cleanup
    if not all(cleanup.values()):
        result["passed"] = False
        result["error"] = "Isolated Resolve project cleanup or prior project restore failed"
    result["closedTransientStartupProject"] = previous_is_transient
    print(json.dumps(result, ensure_ascii=False))
    raise SystemExit(0 if result["passed"] else 1)


if __name__ == "__main__":
    main()
