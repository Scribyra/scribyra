// Test-only implementation of the public WebKitInputMethodContext C API.
// Loaded only in the isolated Linux WPE acceptance browser, never in the app.
// ABI reference: Source/WebKit/UIProcess/API/glib/WebKitInputMethodContext.h.in
#define _GNU_SOURCE
#include <glib-object.h>
#include <dlfcn.h>
#include <stdarg.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>

typedef GObject InputMethod;
// Stable public class prefix, up to the get_preedit virtual function.
typedef struct {
    GObjectClass parent;
    void (*started)(InputMethod *);
    void (*changed)(InputMethod *);
    void (*finished)(InputMethod *);
    void (*committed)(InputMethod *, const char *);
    void (*deleted)(InputMethod *, int, guint);
    void (*enable)(InputMethod *, gboolean);
    void (*preedit)(InputMethod *, gchar **, GList **, guint *);
} InputMethodClass;

static InputMethod *ime;
static char *preedit_text;
static const char *directory;
static _Thread_local int installing;

static void get_preedit(InputMethod *self, gchar **value, GList **underlines,
                        guint *cursor) {
    *value = g_strdup(preedit_text ? preedit_text : "");
    *underlines = NULL;
    *cursor = g_utf8_strlen(*value, -1);
}

static void class_init(gpointer klass, gpointer data) {
    ((InputMethodClass *)klass)->preedit = get_preedit;
}

// Node atomically renames a command into this private directory. Signals run on
// WPE's UI thread through GLib, following the ordinary input-method entry point.
static gboolean poll_command(gpointer unused) {
    char path[4096];
    snprintf(path, sizeof path, "%s/command", directory);
    gchar *line = NULL;
    gsize length = 0;
    if (!g_file_get_contents(path, &line, &length, NULL))
        return G_SOURCE_CONTINUE;
    remove(path);
    if (length > 4096) {
        g_free(line);
        return G_SOURCE_CONTINUE;
    }
    char *argument = strchr(line, ':');
    if (argument)
        *argument++ = 0;
    else
        argument = "";

    if (!strcmp(line, "preedit")) {
        if (!preedit_text || !*preedit_text)
            g_signal_emit_by_name(ime, "preedit-started");
        g_free(preedit_text);
        preedit_text = g_strdup(argument);
        g_signal_emit_by_name(ime, "preedit-changed");
    } else if (!strcmp(line, "commit")) {
        g_signal_emit_by_name(ime, "committed", argument);
        g_free(preedit_text);
        preedit_text = g_strdup("");
        g_signal_emit_by_name(ime, "preedit-changed");
        g_signal_emit_by_name(ime, "preedit-finished");
    } else if (!strcmp(line, "cancel")) {
        g_free(preedit_text);
        preedit_text = g_strdup("");
        g_signal_emit_by_name(ime, "preedit-changed");
        g_signal_emit_by_name(ime, "preedit-finished");
    } else {
        g_free(line);
        return G_SOURCE_CONTINUE;
    }
    snprintf(path, sizeof path, "%s/done", directory);
    g_file_set_contents(path, line, -1, NULL);
    g_free(line);
    return G_SOURCE_CONTINUE;
}

gpointer g_object_new(GType type, const gchar *first, ...) {
    static gpointer (*original)(GType, const gchar *, va_list);
    if (!original)
        original = dlsym(RTLD_NEXT, "g_object_new_valist");
    va_list arguments;
    va_start(arguments, first);
    gpointer object = original(type, first, arguments);
    va_end(arguments);
    if (installing || ime || strcmp(g_type_name(type), "WebKitWebView"))
        return object;
    directory = getenv("SCRIBYRA_NATIVE_IME_DIRECTORY");
    if (!directory)
        return object;
    installing = 1;
    GType (*webview_type)(void) = dlsym(RTLD_DEFAULT, "webkit_web_view_get_type");
    GType (*ime_type)(void) = dlsym(RTLD_DEFAULT, "webkit_input_method_context_get_type");
    void (*set_ime)(void *, InputMethod *) = dlsym(RTLD_DEFAULT, "webkit_web_view_set_input_method_context");
    if (webview_type && ime_type && set_ime && g_type_is_a(type, webview_type())) {
        GTypeQuery info;
        g_type_query(ime_type(), &info);
        if (info.class_size >= sizeof(InputMethodClass)) {
            GType subtype = g_type_register_static_simple(
                ime_type(), "ScribyraNativeTestIME", info.class_size, class_init,
                info.instance_size, NULL, 0);
            // Retain our own reference for this isolated browser's lifetime.
            ime = g_object_new(subtype, NULL);
            set_ime(object, ime);
            g_timeout_add(20, poll_command, NULL);
            char path[4096];
            snprintf(path, sizeof path, "%s/ready", directory);
            g_file_set_contents(path, "ready", -1, NULL);
        }
    }
    installing = 0;
    return object;
}
