#!/usr/bin/env python3
"""Install a stock Godot Android build template into godot/android/build and
re-apply chaosD6's customizations on top of it.

Run after a Godot upgrade (the editor's "Install Android Build Template"
would wipe these). Customizations re-applied:
  - AndroidManifest.xml: v2 plugin <meta-data> (headless export skips .gdap
    injection) + the chaosd6://join deep-link <activity-alias>
  - build.gradle: force-include the plugin AARs + resources/ srcDir
  - gradle.properties: plugins_local_binaries fallback
  - src/com/godot/game/GodotApp.java: deep-link URI -> OS.get_cmdline_args()
  - google-services.json, resources/META-INF/services/... (copied from backup)

Usage: python3 _tools/port_android_template.py <version>   e.g. 4.5.2.stable
"""
import os
import re
import shutil
import sys
import tarfile
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUILD = os.path.join(ROOT, "godot/android/build")
BACKUP = os.path.join(ROOT, "_tools/_cache/android-build-4.3-backup.tar.gz")

# (singleton name, plugin class, plugin dir/AAR name)
PLUGINS = [
    ("NodejsMobile", "io.chaosd6.nodejs.NodejsMobilePlugin", "nodejs_mobile"),
    ("WebViewHud", "io.chaosd6.webview.WebViewHudPlugin", "webview_hud"),
    ("RadicleNode", "io.chaosd6.radicle.RadicleNodePlugin", "radicle_node"),
]


def sub_once(text, anchor, replacement, what):
    if anchor not in text:
        sys.exit(f"[port] anchor for {what} not found — template layout changed, port by hand")
    return text.replace(anchor, replacement, 1)


def edit(path, fn):
    with open(path) as f:
        text = f.read()
    with open(path, "w") as f:
        f.write(fn(text))


def manifest(text):
    meta = "".join(
        f'        <meta-data\n'
        f'            android:name="org.godotengine.plugin.v2.{name}"\n'
        f'            android:value="{cls}" />\n'
        for name, cls, _ in PLUGINS
    )
    text = sub_once(text, "        <activity\n            android:name=\".GodotApp\"",
        "        <!-- chaosD6: Godot v2 plugin registration. Normally injected from each\n"
        "             .gdap at export, but the headless CLI export skips that, so without\n"
        "             these the AARs are packaged yet Engine.has_singleton() stays false. -->\n"
        + meta + "\n"
        "        <activity\n            android:name=\".GodotApp\"", "plugin meta-data")
    return sub_once(text, "        </activity>\n\n    </application>",
        "        </activity>\n\n"
        "        <!-- chaosd6://join?... deep link. An alias, not a filter on GodotApp:\n"
        "             Godot's generated src/<variant>/AndroidManifest.xml declares GodotApp\n"
        "             with tools:node=\"mergeOnlyAttributes\", which drops child elements\n"
        "             from this manifest during the merge. GodotApp.java forwards the URI\n"
        "             to OS.get_cmdline_args() for DimensionLauncher.gd. -->\n"
        "        <activity-alias\n"
        "            android:name=\"com.godot.game.JoinLink\"\n"
        "            android:targetActivity=\"com.godot.game.GodotApp\"\n"
        "            android:exported=\"true\">\n"
        "            <intent-filter>\n"
        "                <action android:name=\"android.intent.action.VIEW\" />\n"
        "                <category android:name=\"android.intent.category.DEFAULT\" />\n"
        "                <category android:name=\"android.intent.category.BROWSABLE\" />\n"
        "                <data android:scheme=\"chaosd6\" android:host=\"join\" />\n"
        "            </intent-filter>\n"
        "        </activity-alias>\n\n"
        "    </application>", "deep-link alias")


def build_gradle(text):
    includes = "".join(
        f'\n    File chaosd6{d.title().replace("_", "")}Aar = file("$rootDir/../plugins/{d}/{d}.aar")\n'
        f'    if (chaosd6{d.title().replace("_", "")}Aar.exists()) {{\n'
        f'        implementation files(chaosd6{d.title().replace("_", "")}Aar.absolutePath)\n'
        f'    }} else {{\n'
        f'        logger.warn("[chaosD6] {d}.aar not found at " + chaosd6{d.title().replace("_", "")}Aar.absolutePath + " — building without the {name} plugin. Build it with the plugin\'s `./gradlew assembleRelease` and copy the AAR beside the .gdap.")\n'
        f'    }}\n'
        for name, _, d in PLUGINS
    )
    anchor = ("    if (pluginsBinaries != null && pluginsBinaries.size() > 0) {\n"
              "        implementation files(pluginsBinaries)\n"
              "    }\n")
    text = sub_once(text, anchor, anchor +
        "\n    // chaosD6: force-include the plugin AARs. Godot's headless CLI export\n"
        "    // does not auto-discover `.gdap` files from godot/android/plugins/* — it\n"
        "    // invokes gradle with `-Pplugins_local_binaries=` (empty) — so inject them\n"
        "    // as plain file dependencies. Missing AAR = warning, plugin-less APK.\n"
        + includes, "AAR force-include")
    return sub_once(text, "            assets.srcDirs = ['assets']\n",
        "            assets.srcDirs = ['assets']\n"
        "            // chaosD6: v2 plugin discovery uses ServiceLoader on\n"
        "            // META-INF/services/org.godotengine.godot.plugin.GodotPlugin; AAR\n"
        "            // Java resources don't reliably propagate, so declare them here too.\n"
        "            resources.srcDirs = ['resources']\n", "resources srcDir")


def gradle_properties(text):
    aars = ",".join(f"../plugins/{d}/{d}.aar" for _, _, d in PLUGINS)
    return sub_once(text, "android.useAndroidX=true\n",
        "android.useAndroidX=true\n\n"
        "# chaosD6: local plugin AARs the headless CLI export does not discover from\n"
        "# .gdap files. Relative to this gradle root (godot/android/build/). Keep in\n"
        "# sync with build.gradle's force-includes and godot/android/plugins/.\n"
        f"plugins_local_binaries={aars}\n", "plugins_local_binaries")


def godot_app(text):
    text = sub_once(text, "import android.os.Bundle;\n",
        "import android.content.Intent;\nimport android.net.Uri;\nimport android.os.Bundle;\n", "imports")
    text = sub_once(text, "import androidx.core.splashscreen.SplashScreen;\n",
        "import androidx.core.splashscreen.SplashScreen;\n\n"
        "import java.util.ArrayList;\nimport java.util.List;\n", "java.util imports")
    body = (
        "\n\t// Godot builds OS.get_cmdline_args() from GodotHost.getCommandLine() and\n"
        "\t// never looks at Intent.getData(), so the chaosd6://join?... URI is appended here.\n"
        "\t@Override\n"
        "\tpublic List<String> getCommandLine() {\n"
        "\t\tList<String> args = new ArrayList<>(super.getCommandLine());\n"
        "\t\tUri data = getIntent() != null ? getIntent().getData() : null;\n"
        "\t\tif (data != null && \"chaosd6\".equals(data.getScheme())) {\n"
        "\t\t\targs.add(data.toString());\n"
        "\t\t}\n"
        "\t\treturn args;\n"
        "\t}\n\n"
        "\t// A link tapped while the game is already running: let Godot's own\n"
        "\t// EXTRA_NEW_LAUNCH path restart the engine so getCommandLine() sees the new URI.\n"
        "\t@Override\n"
        "\tprotected void onNewIntent(Intent intent) {\n"
        "\t\tUri data = intent.getData();\n"
        "\t\tif (data != null && \"chaosd6\".equals(data.getScheme())) {\n"
        "\t\t\tintent.putExtra(getEXTRA_NEW_LAUNCH(), true);\n"
        "\t\t}\n"
        "\t\tsuper.onNewIntent(intent);\n"
        "\t}\n"
    )
    if "onNewIntent" in text or "getCommandLine" in text:
        sys.exit("[port] stock GodotApp.java already overrides onNewIntent/getCommandLine — merge by hand")
    head, _, tail = text.rpartition("}")
    return head.rstrip("\n") + "\n" + body + "}" + tail


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    version = sys.argv[1]
    src_zip = os.path.expanduser(f"~/.local/share/godot/export_templates/{version}/android_source.zip")
    if not os.path.isfile(src_zip):
        sys.exit(f"[port] {src_zip} missing — install the {version} export templates first")
    if not os.path.isfile(BACKUP):
        sys.exit(f"[port] {BACKUP} missing — back up godot/android/build first")

    shutil.rmtree(BUILD, ignore_errors=True)
    os.makedirs(BUILD)
    with zipfile.ZipFile(src_zip) as z:
        z.extractall(BUILD)
    os.chmod(os.path.join(BUILD, "gradlew"), 0o755)
    # The export reads res://android/.build_version (beside build/, not in it).
    for d in (BUILD, os.path.dirname(BUILD)):
        with open(os.path.join(d, ".build_version"), "w") as f:
            f.write(version + "\n")
    open(os.path.join(BUILD, ".gdignore"), "w").close()

    # Files that only exist in our template come straight from the backup.
    with tarfile.open(BACKUP) as t:
        for m in t.getmembers():
            name = m.name.lstrip("./")
            if name == "google-services.json" or name.startswith("resources/"):
                t.extract(m, BUILD)
    services = os.path.join(BUILD, "resources/META-INF/services/org.godotengine.godot.plugin.GodotPlugin")
    with open(services, "w") as f:
        f.write("".join(cls + "\n" for _, cls, _ in PLUGINS))

    edit(os.path.join(BUILD, "AndroidManifest.xml"), manifest)
    edit(os.path.join(BUILD, "build.gradle"), build_gradle)
    edit(os.path.join(BUILD, "gradle.properties"), gradle_properties)
    edit(os.path.join(BUILD, "src/com/godot/game/GodotApp.java"), godot_app)
    print(f"[port] godot/android/build = stock {version} + chaosD6 customizations")


if __name__ == "__main__":
    main()
