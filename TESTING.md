# Unit Testing Guide

This project is configured with support for unit testing using the Check framework.

## Prerequisites

Make sure the Check framework and CMake are installed on your system:

### Ubuntu/Debian
```bash
sudo apt-get install cmake check libcheck-dev pkg-config
```

### CentOS/RHEL/Fedora
```bash
# CentOS/RHEL
sudo yum install cmake check-devel pkgconfig
# or Fedora
sudo dnf install cmake check-devel pkgconfig
```

## Building and Running Tests

1. **Configure and build the project**:
```bash
cmake -B build
cmake --build build
```

2. **Run tests**:
```bash
cd build && ctest
```

## Adding New Tests

### Adding Tests to Existing Modules

Add new test functions in `tests/check_http.c`:

```c
START_TEST(test_your_new_function)
{
    // Test code
    ck_assert_msg(condition, "error message");
}
END_TEST
```

Then add to the appropriate test suite:

```c
tcase_add_test(tc_headers, test_your_new_function);
```

### Creating Tests for New Modules

1. Create a new test file in the `tests/` directory, e.g., `check_rtp.c`
2. Add the test target to `CMakeLists.txt`
3. Re-run `cmake -B build` to pick up the new test

## Notes

- Test programs are located in the `tests/` directory
- Test output files are generated during the build process and can be safely deleted

## Troubleshooting

If you encounter compilation errors:
1. Ensure the Check framework development packages are properly installed
2. Verify that pkg-config can find the check library: `pkg-config --cflags --libs check`
3. Check that the include paths in test files are correct
4. If using a cross-compilation environment, ensure the target platform also has the Check framework
