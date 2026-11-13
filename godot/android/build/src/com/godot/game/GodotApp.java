/**************************************************************************/
/*  GodotApp.java                                                         */
/**************************************************************************/
/*                         This file is part of:                          */
/*                             GODOT ENGINE                               */
/*                        https://godotengine.org                         */
/**************************************************************************/
/* Copyright (c) 2014-present Godot Engine contributors (see AUTHORS.md). */
/* Copyright (c) 2007-2014 Juan Linietsky, Ariel Manzur.                  */
/*                                                                        */
/* Permission is hereby granted, free of charge, to any person obtaining  */
/* a copy of this software and associated documentation files (the        */
/* "Software"), to deal in the Software without restriction, including    */
/* without limitation the rights to use, copy, modify, merge, publish,    */
/* distribute, sublicense, and/or sell copies of the Software, and to     */
/* permit persons to whom the Software is furnished to do so, subject to  */
/* the following conditions:                                              */
/*                                                                        */
/* The above copyright notice and this permission notice shall be         */
/* included in all copies or substantial portions of the Software.        */
/*                                                                        */
/* THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,        */
/* EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF     */
/* MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. */
/* IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY   */
/* CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,   */
/* TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE      */
/* SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.                 */
/**************************************************************************/

package com.godot.game;

import org.godotengine.godot.GodotActivity;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;

import androidx.core.splashscreen.SplashScreen;

import java.util.ArrayList;
import java.util.List;

/**
 * Template activity for Godot Android builds.
 * Feel free to extend and modify this class for your custom logic.
 */
public class GodotApp extends GodotActivity {
	@Override
	public void onCreate(Bundle savedInstanceState) {
		SplashScreen.installSplashScreen(this);
		super.onCreate(savedInstanceState);
	}

	// Godot 4.3 builds OS.get_cmdline_args() from GodotHost.getCommandLine() and
	// never looks at Intent.getData(), so the chaosd6://join?... URI is appended here.
	@Override
	public List<String> getCommandLine() {
		List<String> args = new ArrayList<>(super.getCommandLine());
		Uri data = getIntent() != null ? getIntent().getData() : null;
		if (data != null && "chaosd6".equals(data.getScheme())) {
			args.add(data.toString());
		}
		return args;
	}

	// A link tapped while the game is already running: let Godot's own
	// EXTRA_NEW_LAUNCH path restart the engine so getCommandLine() sees the new URI.
	@Override
	protected void onNewIntent(Intent intent) {
		Uri data = intent.getData();
		if (data != null && "chaosd6".equals(data.getScheme())) {
			intent.putExtra(getEXTRA_NEW_LAUNCH(), true);
		}
		super.onNewIntent(intent);
	}
}
